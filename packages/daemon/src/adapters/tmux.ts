import type { InputReadDiagnostic } from "../domain/input-read-diagnostic.js";
import { windowsPowerShell } from "../domain/windows-executables.js";
import { DeliveryGuardError, type SeatDeliveryGuard } from "../domain/seat-delivery-guard.js";
import { writeFile as fsWriteFile, unlink as fsUnlink, readFile as fsReadFile } from "node:fs/promises";
import { accessSync, statSync, constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { basename as pathBaseName, isAbsolute as pathIsAbsolute, join as pathJoin } from "node:path";
import { randomUUID } from "node:crypto";
import type { ComposerSnapshot } from "../domain/composer-prompts.js";
import type { TerminalServerObservation } from "../domain/terminal-server-reachability.js";
import { inspectComposerInput } from "../domain/session-transport.js";
import { parentSessionEnvKeys, removeParentSessionEnv } from "../domain/parent-session-env.js";
import { isTmuxCredentialEnvKey } from "./tmux-credential-env.js";
import { bindNativeSessionName, isEncodedNativeSessionName, logicalNameFromNativeBinding, nativeSessionNameMayBeLegacy, NATIVE_LOGICAL_SESSION_OPTION } from "../domain/terminal/native-session-name.js";
import { addSeatRuntimeDir, seatRuntimeDir } from "../domain/seat-runtime-dir.js";
import type { TmuxControlExec } from "./tmux-control.js";
import { powershellQuote, hasOnlyWindowsTerminalResponseDraft } from "./windows-launch.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isWindowsPrivateEnvironmentName, psmuxPrivateEnvironmentLine, writeWindowsPrivateConfig, type PrivateConfig } from "./windows-private-config.js";
import { createPrivateTextFileAsync } from "../domain/private-text-file.js";
import { readWindowsSeatJobForPane } from "../domain/windows-seat-job-readback.js";
import { isStagedSendName, SEND_SCRIPT_PREFIX, SEND_SCRIPT_SUFFIX } from "./staged-send-name.js";
import { windowsCmdBridgeInvocation, windowsPosixBridgeInvocation } from "../domain/windows-cmd-bridge.js";
import { windowsScopedLaunch } from "./windows-scoped-launch.js";
import { nextNativeRuntimeExchangeStep, type NativeExchangeIdentity, type NativeExchangeSlot } from "../domain/native-runtime-switch-exchange.js";
import type { NativeExchangeTerminal } from "../domain/native-runtime-switch-journal.js";
import { NativeNameTransition, type NativePhysicalObservation, type NativePhysicalSession } from "../domain/native-name-transition.js";
import { readPlatformEnv } from "../domain/platform-env.js";
import { tmuxFormatLiteral, tmuxSessionNameFormat } from "./tmux-format.js";
import { observeCodexPaneProcess } from "../domain/native-process-lineage.js";
const execFileAsync = promisify(execFile);
import { tmuxOnDaemonServer } from "./tmux-server.js";
import { TMUX_SERVER_LIMIT_PREFIX, TMUX_SERVER_NO_SESSION_BUS, TMUX_SERVER_SESSION_BUS } from "../tmux-server-start.js";

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
  /** The staged script is POSIX shell only (a Claude seat's token step): with sourceInPane, a POSIX pane still sources it,
   *  but a fish pane runs it with /bin/sh instead of sourcing it. */
  posix?: boolean;
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
  | { ok: true; warnings?: string[]; stopPhase?: StopPhase;
    /** #3253: a recovery that went ahead without the seat's requested limit. */
    processLimits?: SeatProcessLimitsNotice }
  | { ok: false; code: string; message: string; stopPhase?: StopPhase; inputReadFailure?: InputReadDiagnostic;
    /** #3253: a fresh launch whose limit can't be applied (`process_limits_*`); retryable when unverified. */
    retryable?: boolean; processLimits?: SeatProcessLimitsProblem };

/** How a launch treats a seat's limit it can't apply (#3253): a fresh launch is not started; a recovery (a handover, a
 *  provider switch, a restart in place) goes ahead without it, with a structured warning. */
export type ProcessLimitsMode = "fresh" | "recovery";

/** What one launch learned about the seat's scope: the warning of a recovery without it, whether the command was
 *  capped (with its requested limit and the marker its command writes once it runs inside the scope), and (for the
 *  uncapped retry of a recovery) why the capped start failed. */
interface ScopeNotices { processLimits?: SeatProcessLimitsNotice; capped?: boolean; requested?: SeatProcessLimits;
  marker?: string; failedStart?: SeatProcessLimitsProblem }

/** How a capped launch sees its seat's scope start: the pane's process is in the seat scope and its command started
 *  there (started), or the pane died first, before the command started (systemd-run could not make the scope, also
 *  late, after the check passed) or after it (the command ran inside the scope and ended). It looks for longer than
 *  systemd-run's own call to the user manager may take (D-Bus's default 25 s timeout), so a late answer either way is
 *  seen. */
const SEAT_SCOPE_START_CHECK_MS = 250;
const SEAT_SCOPE_START_CHECKS = 120;

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

/** The first line of tmux's own diagnostic for a lost server, for a log line or a status field. */
function serverDiagnostic(error: unknown): string {
  const reported = tmuxReportedError(error);
  const message = reported instanceof Error ? reported.message : String(reported);
  return tmuxDiagnosticStart(message).split(/\r?\n/, 1)[0]!.trim();
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

/** No server answers on the socket: tmux's "no server running", or a socket that is missing or refuses, read from what
 *  tmux said (its stderr when the exec kept it, else the message past an exec's "Command failed" line). */
function isServerMissingError(err: unknown): boolean {
  const reported = tmuxReportedError(err);
  if (!(reported instanceof Error)) return false;
  const said = new Error(tmuxDiagnosticStart(reported.message).trim());
  return isNoServerError(said) || isTmuxTransportAbsentError(said);
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
  if (err instanceof DeliveryGuardError) return { ok: false, code: err.code, message: err.message, ...(err.inputReadFailure ? { inputReadFailure: err.inputReadFailure } : {}) };
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

/**
 * A key argument escaped so tmux treats it as one argument, not as a command boundary.
 *
 * tmux ends its command at an argument ending in `;` unless the character immediately before that `;`
 * is a backslash, in which case it drops the `;` and turns that one backslash into a `;`
 * (`cmd_parse_from_arguments` in tmux's `cmd-parse.y`; see `commandsOf` in tmux-control.ts, pinned
 * against real tmux in test/tmux-control-native.test.ts). It checks one character, not a run of them:
 * there is no parity rule and no notion of an already escaped argument.
 *
 * So every trailing `;` gets exactly one backslash in front of it, unconditionally, and each key then
 * arrives byte for byte: `x;` is sent as `x\;` and arrives as `x;`, and `x\;` is sent as `x\\;` and
 * arrives as `x\;`. Quoting protects the SHELL, not tmux: `send-keys -t X 'x;'` still reaches tmux as
 * two commands.
 *
 * This narrows nothing: a caller may still send any key argument it sent before, and the argument
 * arrives at the pane as the same bytes. Both transports receive the escaped form, so the spawned
 * client and the control client read the same argv.
 */
export function escapeTmuxCommandSeparator(key: string): string {
  return key.endsWith(";") ? `${key.slice(0, -1)}\\;` : key;
}
/** The launch warning when the parent-session identity cleanup could not finish (#771). */
function parentSessionEnvWarning(target: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `${target}: could not remove the launching session's identity (for example CLAUDECODE) from this seat's environment, so the seat may still see it: ${reason}`;
}

/** Shell-quote a string using single quotes (POSIX-safe). */
/** One pane's text from a batched capture, with the time its chunk was read (#309 review). `text` is null for a
 *  session that is gone or an empty capture. */
export interface PaneCapture { text: string | null; capturedAt: Date; /** The listing lacked the session. */ missing?: true;
  /** The pane and its process that this capture read, from the same tmux call (#2515). */
  pane?: { id: string; pid: number } }

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

/** The stderr a failed exec kept apart, or "" (a timeout, a spawn error). Never the message: it echoes the command. */
function execStderrText(error: unknown): string {
  const e = error as { execStderr?: unknown; stderr?: unknown };
  return typeof e.execStderr === "string" && e.execStderr.trim() ? e.execStderr
    : typeof e.stderr === "string" ? e.stderr : "";
}

/** systemd-run's own refusal of an option it does not have (before 254), read from its stderr only. */
const NO_EXPAND_ENVIRONMENT = /(?:unrecognized|unknown) option[^\n]*--expand-environment/i;
/** The user manager's refusal of OOMPolicy= for a scope (before 253), read from systemd-run's stderr only. */
const NO_OOM_POLICY = /Cannot set property OOMPolicy|Unknown (?:property|assignment)[^\n]*OOMPolicy/i;
/** systemd-run's or the user manager's refusal of MemoryMax= for a scope, read from systemd-run's stderr only. */
const NO_MEMORY_MAX = /Unknown (?:property|assignment)[^\n]*MemoryMax|Failed to parse MemoryMax/i;
/** A systemd too old for a seat scope: systemctl without --value (before 230) or systemd-run without --collect (before
 *  236), read from their stderr only. */
const SYSTEMD_TOO_OLD = /(?:unrecognized|unknown) option[^\n]*--(?:value|collect)\b/i;

/** What a failed exec said, on one line: its stderr when it kept one apart, else its message past the command. */
function execFailureReason(error: unknown): string {
  const e = error as { execStderr?: unknown; stderr?: unknown; message?: unknown; code?: unknown };
  const stderr = typeof e.execStderr === "string" && e.execStderr.trim() ? e.execStderr
    : typeof e.stderr === "string" && e.stderr.trim() ? e.stderr : "";
  const text = stderr || tmuxDiagnosticStart(String(e.message ?? error));
  const reason = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean).join("; ");
  return reason || `systemd-run failed${e.code !== undefined ? ` (exit ${String(e.code)})` : ""}`;
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

/** A seat's own process limits (rig spec `process_limits`, #3253): the task limit, the memory limit (bytes), or both
 *  (at least one). */
export interface SeatProcessLimits { tasksMax?: number; memoryMax?: number }

/** Where a seat's limits stand, read back from the kernel, never from config alone (#3253):
 *  - `applied`: the pane's process is in a seat scope whose pids.max and memory.max are the requested values (each one
 *    that was requested);
 *  - `not_applied` ("requested, not applied"): known not to be under them (not running, launched before the limit was
 *    set or by a recovery that went ahead without it, outside a seat scope, or a different pids.max or memory.max);
 *  - `unsupported`: not under it, and this host or setup positively can't give the seat a scope;
 *  - `unknown`: the readback itself failed (no pane pid, cgroup v1, unreadable files);
 *  - `invalid`: the stored request can't be read; kept as stored, and only this seat is affected. */
export type SeatProcessLimitsState = "applied" | "not_applied" | "unsupported" | "unknown" | "invalid";
export interface SeatProcessLimitsReport {
  state: SeatProcessLimitsState;
  /** The stored request (absent when it is `invalid`). */
  requested?: SeatProcessLimits;
  /** Why the state is not `applied`, naming the limit that isn't. */
  reason?: string;
  /** Only when read, and tasks_max was requested: the scope's pids.max, pids.current and how many times a fork hit the
   *  limit (pids.events `max`). */
  pidsMax?: string; pidsCurrent?: number; limitHits?: number;
  /** Only when read, and memory_max was requested: the scope's memory.max and memory.current, how many times its usage
   *  was about to go over the limit (memory.events `max`), and how many processes in the scope an OOM killer killed
   *  (memory.events `oom_kill`, any OOM killer: not proof that this limit ended the seat). */
  memoryMax?: string; memoryCurrent?: number; memoryLimitHits?: number; oomKills?: number;
  memoryAccounting?: "job_commit";
  /** The seat's scope unit, when the process is in one. */
  scope?: string;
  /** Which process the status read: the seat's own pane, or its session's active pane when no pane is recorded. */
  readFrom?: string;
}

/** Why a seat's limit can't be applied at a launch (#3253):
 *  - `unsupported`: a positive inability of this host (not Linux, no user manager to ask or running, systemd-run
 *    missing, no cgroup v2, or no pids or memory controller for the user manager, a throwaway scope whose pids.max or
 *    memory.max is not the limit, MemoryMax= refused);
 *  - `setup`: the host may well make the scope, but this setup or launch path can't use it (terminal.
 *    inherit_tmux_environment on, a daemon with no launch environment, a restart in place that keeps or respawns a
 *    process without the seat's scope), with the way out;
 *  - `unverified`: not known either way, and worth retrying (the user bus timed out, the probe read nothing, an error
 *    not recognized, or such a failure cached `ageSeconds` ago);
 *  - `invalid`: the seat's stored request can't be read. */
export interface SeatProcessLimitsProblem {
  kind: "unsupported" | "setup" | "unverified" | "invalid";
  reason: string;
  requested?: SeatProcessLimits;
  /** Which requested limit this host can't give, when one is named (a seat that asks for memory_max): the seat has one
   *  scope, so either one refuses the whole seat. */
  limit?: "tasks_max" | "memory_max";
  /** For a cached observation: how old it is. */
  ageSeconds?: number;
  /** A refused fresh launch whose terminal couldn't be removed (or wasn't identified): it may be running, so the
   *  outcome is unknown and a retry isn't suggested until it is stopped. */
  possiblyRunning?: true;
  /** A refused fresh launch whose command started inside the seat's scope before the refusal (its marker was emptied:
   *  `true`) or may have (the marker couldn't be read: "unknown"). It may have done work, so it is not a failure before
   *  the command, and a retry isn't suggested; whether its terminal was removed is said apart. A recovery's `unknown`
   *  notice carries it too, for the same reading: there nothing is refused or run again, and its `retryable` only says
   *  the limit check may pass at the next fresh launch. */
  commandStarted?: true | "unknown";
}

/** The structured warning of a recovery (handover, provider switch, restart in place) that went ahead without the
 *  seat's requested limit (`not_applied`), or that can't tell whether its process is under it and ran nothing again
 *  (`unknown`: the readback failed, or a capped start was not confirmed): the request stays stored, and the seat's
 *  status reads where the limit stands. */
export interface SeatProcessLimitsNotice extends SeatProcessLimitsProblem {
  state: "not_applied" | "unknown";
  retryable: boolean;
}

/** A fresh launch that asks for a limit it can't get: it is not started, and says why (#3253: never an unlimited start
 *  that claims success). */
export class SeatProcessLimitsNotApplied extends Error {
  constructor(readonly problem: SeatProcessLimitsProblem) {
    super(`process_limits is set for this seat, but ${problemText(problem)}; the seat was not started` +
      (problem.kind === "unverified" ? " (this may be temporary: retry the launch)" : "") + ".");
  }
}

/** One line for a problem, with the age of a cached observation. */
export function problemText(problem: SeatProcessLimitsProblem): string {
  const what = problem.kind === "invalid" ? "its stored value can't be read"
    : problem.kind === "unsupported" ? "this host can't give the seat its own scope"
    : problem.kind === "setup" ? "this setup can't give the seat its own scope"
    : "whether this host can give the seat its own scope is unverified";
  const age = problem.ageSeconds !== undefined ? `, observed ${problem.ageSeconds}s ago` : "";
  return `${what} (${problem.reason}${age})`;
}

/** The structured warning of a recovery that went ahead without the limit. */
export function notAppliedNotice(problem: SeatProcessLimitsProblem): SeatProcessLimitsNotice {
  return { state: "not_applied", ...problem, retryable: problem.kind === "unverified" };
}

/** The structured warning of a recovery that can't tell whether the seat's process is under the limit. */
export function unknownNotice(problem: SeatProcessLimitsProblem): SeatProcessLimitsNotice {
  return { state: "unknown", ...problem, retryable: problem.kind === "unverified" };
}

/** The human line of that warning. */
export function noticeLine(notice: SeatProcessLimitsNotice): string {
  if (notice.state === "unknown") {
    const age = notice.ageSeconds !== undefined ? `, observed ${notice.ageSeconds}s ago` : "";
    return `process_limits requested; whether the seat runs under the limit is unknown (${notice.reason}${age}); the ` +
      "request stays stored (a fresh launch applies it)";
  }
  return `process_limits requested, not applied: ${problemText(notice)}; the seat went on without the limit, and the ` +
    "request stays stored (a fresh launch applies it)";
}

/** The slice a seat scope goes in: seats with process limits leave the terminal server's scope (and any limit an
 *  operator put on it) for this slice. No dash: systemd reads a dash in a slice name as nesting, which would put the
 *  seats under `openrig.slice` and any limit on it. */
export const SEAT_SCOPE_SLICE = "openrigseats.slice";
/** Why a seat with a limit can't start with the inherited tmux environment, with the way out. */
const INHERIT_TMUX_ENVIRONMENT_REASON = "terminal.inherit_tmux_environment is on: a seat with a limit needs the scoped " +
  "launch environment (set terminal.inherit_tmux_environment to false)";
/** How long a launch skips asking again after a failed check (it reads as `unverified`, with the observation's age). */
const SEAT_SCOPE_RETRY_MS = 60_000;

/** systemd-run reaches the user manager through the runtime directory, not the seat's session bus (which the launch
 *  environment turns off on purpose). The command after `--` restores the seat's exact environment (env -i + export). */
function seatScopeBusEnv(runtimeDir: string): string[] {
  return ["/usr/bin/env", "-u", "DBUS_SESSION_BUS_ADDRESS", `XDG_RUNTIME_DIR=${runtimeDir}`];
}

/** `/usr/bin/env` that gives the command these values back: every `-u` (an unset value) before any assignment, since env
 *  reads the first word after an assignment as the command. */
export function restoreEnvArgv(values: Record<string, string | undefined>): string[] {
  const entries = Object.entries(values);
  return ["/usr/bin/env", ...entries.filter(([, v]) => v === undefined).flatMap(([k]) => ["-u", k]),
    ...entries.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`)];
}

/** The systemd-run options of a seat scope, up to (not including) the `--` before the command. `systemdRun` is the
 *  absolute path the check resolved, so the check and the launch run the same binary whatever PATH the seat has. */
function seatScopeArgv(opts: { literal: boolean; oomPolicy: boolean }, unit: string, description: string,
  limits: SeatProcessLimits, systemdRun: string): string[] {
  return [systemdRun, "--user", "--scope", "--quiet", "--collect", "--slice", SEAT_SCOPE_SLICE, "--unit", unit,
    "--description", description,
    // As for the server's scope: the command's arguments must reach /bin/sh exactly as written (254+).
    ...(opts.literal ? ["--expand-environment=no"] : []),
    // As for the server's scope: one OOM kill must not stop every process of the seat (253+).
    ...(opts.oomPolicy ? ["-p", "OOMPolicy=continue"] : []),
    ...(limits.tasksMax !== undefined ? ["-p", `TasksMax=${limits.tasksMax}`] : []),
    // Bytes, as memory.max reads back: the probe and the status compare the two as written.
    ...(limits.memoryMax !== undefined ? ["-p", `MemoryMax=${limits.memoryMax}`] : [])];
}

/** The command that runs first inside a seat scope: it empties the launch's marker file (a builtin and a redirection, no
 *  fork, so it works under TasksMax=1), then execs the seat's command. A pane that died with the marker still pending
 *  never started the seat's command; one that died with it empty did. */
function scopeMarkArgv(marker: string): string[] {
  return ["/bin/sh", "-c", ': > "$0" && exec "$@"', marker];
}
const SCOPE_MARKER_PENDING = "pending\n";

/** The executables a seat scope needs, resolved once to absolute paths. */
interface SeatScopeTools { systemdRun: string; systemctl: string; timeout: string }

/** The launch policy a seat launch reads once (TmuxAdapter.launchEnvironment). */
export interface SeatLaunchPolicy { inheritTmuxEnvironment: boolean; env: Readonly<Record<string, string | undefined>>;
  /** The runtime directory a seat gets when it has none of its own (seat-runtime-dir.ts); none on macOS. */
  runtimeDir?: string }

/** The launch result of a fresh seat launch whose limit can't be applied. */
function processLimitsNotAppliedResult(error: SeatProcessLimitsNotApplied, left?: string | null): TmuxResult {
  // What was observed about the command and what became of its terminal are said apart: a refusal whose command
  // started (or may have) is not "not started", and one whose terminal may still be running has an unknown outcome.
  // Either way a blind retry could repeat the command or start a second one beside it, so none is suggested.
  const started = error.problem.commandStarted;
  const problem: SeatProcessLimitsProblem = left ? { ...error.problem, possiblyRunning: true } : error.problem;
  let message = error.message;
  if (started || left) {
    message = `process_limits is set for this seat, but ${problemText(error.problem)}; the launch was refused`;
    if (started) message += `, after its command ${started === true ? "started" : "may have started"} in the seat's scope`;
    message += left
      ? `, and whether its terminal is running is unknown. ${left} Stop it before launching this seat again.`
      : "; its terminal was removed. Check what the command did before launching this seat again.";
  }
  console.warn(`[seat launch] ${message}`);
  return { ok: false, code: `process_limits_${error.problem.kind}`, message,
    retryable: !left && !started && error.problem.kind === "unverified", processLimits: problem };
}

/** What a capped launch's new-session prints: its pane, its session's immutable id and its server (pid, start time). */
const CREATED_IDENTITY_FORMAT = "#{pane_id} #{session_id} #{pid} #{start_time}";
type CreatedIdentity = { pane: string; session: string; server: { pid: string; start: string } };
/** The identity a capped new-session printed, or null when it printed something else (or nothing). */
function createdIdentity(printed: string): CreatedIdentity | null {
  const m = /^(%\d+) (\$\d+) (\d+) (\d+)$/.exec(printed);
  return m ? { pane: m[1]!, session: m[2]!, server: { pid: m[3]!, start: m[4]! } } : null;
}

/** How a command that ended by SIGKILL was reported, in words that name only that, or null when it didn't end that way:
 *  the signal itself (the shell replaced by the command; no exit code) or the exit status 137 (128 + 9, from a shell
 *  that ran it, or from timeout, which exits that way when the command it ran was killed). */
function sigkillSeen(error: unknown): string | null {
  const e = error as { code?: unknown; signal?: unknown };
  if (e.code === 137) return "exited with status 137 (128 + SIGKILL)";
  if (e.signal === "SIGKILL") return "was killed by SIGKILL (no exit code)";
  return null;
}

/** A check's failure, classified (#3253): `unsupported` only on a positive answer that the facility is not there. */
function classifyScopeFailure(error: unknown, what: string): SeatProcessLimitsProblem {
  const reason = execFailureReason(error);
  const code = (error as { code?: unknown }).code;
  if (code === 124) return { kind: "unverified", reason: `${what} timed out` };
  // systemd's own refusal of an option it predates, read from its stderr only.
  if (SYSTEMD_TOO_OLD.test(execStderrText(error))) {
    return { kind: "unsupported", reason: `${what}: systemd is too old for seat scopes (it needs 236+ for --collect, 230+ for --value): ${reason}` };
  }
  if (NO_MEMORY_MAX.test(execStderrText(error))) {
    return { kind: "unsupported", limit: "memory_max", reason: `${what}: systemd refused MemoryMax= for the seat's scope: ${reason}` };
  }
  // Only a message that names the tool: an exit status of 127 alone does not say which program was missing.
  if (/(?:systemd-run|systemctl)\S{0,2}: (?:(?:command )?not found|No such file or directory)|No such file or directory[^\n]*(?:systemd-run|systemctl)/i.test(reason)) {
    return { kind: "unsupported", reason: `${what}: systemd-run or systemctl is not installed (${reason})` };
  }
  // No socket at all: no user manager runs for this user (no session and no lingering), a positive answer.
  if (/Failed to connect to (?:user scope )?bus(?: via local transport)?: (?:No such file or directory|No medium found)/i.test(reason)) {
    return { kind: "unsupported", reason: `${what}: no systemd user manager is running for this user (${reason})` };
  }
  // A socket that refuses: a user manager starting or restarting, not known either way.
  if (/Failed to connect to [^:\n]*bus[^:\n]*: Connection refused/i.test(reason)) {
    return { kind: "unverified", reason: `${what}: the user manager's bus refused the connection (starting or restarting?): ${reason}` };
  }
  return { kind: "unverified", reason: `${what} failed: ${reason}` };
}
/** What a throwaway scope with memory_max printed (proveSeatScope), checked limit by limit against the request: null
 *  when each requested limit reads back as its value, else the first that doesn't, named. */
/** A host with no cgroup v2 for the user manager's scopes: no limit can be made, whatever is asked. */
const NO_CGROUP2 = "the user manager's scopes have no cgroup v2 path (a cgroup v1 host)";

/** The limits a positive inability is about: the one a probe's answer names; from the tasks-only probe, whose answers
 *  name none, the task limit when it is about the pids controller; any other (no cgroup v2, no systemd tools or user
 *  manager, a systemd too old) is about the host, so about every limit. */
function inabilityLimits(problem: SeatProcessLimitsProblem, probed: SeatProcessLimits): Array<"tasks_max" | "memory_max"> {
  if (problem.limit) return [problem.limit];
  if (probed.memoryMax === undefined && problem.reason !== NO_CGROUP2 && /\bpids\b/.test(problem.reason)) {
    return ["tasks_max"];
  }
  return ["tasks_max", "memory_max"];
}

function scopeProbeProblem(got: string, limits: SeatProcessLimits): SeatProcessLimitsProblem | null {
  if (got === "nocgroup2") return { kind: "unsupported", reason: NO_CGROUP2 };
  const read = new Map<string, string>();
  for (const line of got.split("\n")) {
    const m = /^(memory|pids) (.*)$/.exec(line.trim());
    if (m) read.set(m[1]!, m[2]!);
  }
  const asked: Array<["memory_max" | "tasks_max", "memory" | "pids", string, number | undefined]> = [
    ["memory_max", "memory", "MemoryMax", limits.memoryMax], ["tasks_max", "pids", "TasksMax", limits.tasksMax]];
  for (const [limit, controller, property, value] of asked) {
    if (value === undefined) continue;
    const file = `${controller}.max`;
    const seen = read.get(controller);
    if (seen === undefined) return { kind: "unverified", limit, reason: `a throwaway seat scope read no ${file}` };
    if (seen === `no${controller}`) {
      return { kind: "unsupported", limit, reason: `a throwaway seat scope has no ${file}: the ${controller} controller is not delegated to the user manager` };
    }
    // Only a readable limit that isn't the one asked for is a positive answer; anything else can't be read.
    if (!/^(\d+|max)$/.test(seen)) {
      return { kind: "unverified", limit, reason: `a throwaway seat scope's ${file} read could not be understood ("${seen.slice(0, 80)}")` };
    }
    if (seen !== String(value)) {
      return { kind: "unsupported", limit,
        reason: `a throwaway seat scope got ${file} "${seen}" for ${property}=${value}: the ${controller} limit is not enforced here (is the ${controller} controller delegated to the user manager?)` };
    }
  }
  return null;
}

/** The cgroup v2 path of a process, from the `0::` line of /proc/<pid>/cgroup; null on cgroup v1 or no such line. */
export function cgroupV2Path(procCgroup: string): string | null {
  const line = procCgroup.split(/\r?\n/).find((l) => l.startsWith("0::"));
  return line ? line.slice(3).trim() || null : null;
}

export class TmuxAdapter {
  /** Read for each new agent/successor, once per launch. Unconfigured adapters retain legacy behavior. */
  launchEnvironment?: () => SeatLaunchPolicy;

  /** A seat's process limits by node id (rig spec `process_limits`, #3253), read at each launch. Absent, or undefined
   *  for a node: that seat launches exactly as before. It may throw for a malformed stored value: that seat's launch
   *  reads it as `invalid`, and no other seat is affected. */
  seatProcessLimits?: (nodeId: string) => SeatProcessLimits | undefined;

  /** Whether a seat runs in an environment guest (its harness is a local viewer of a guest's agent): a scope on this
   *  host would hold only the viewer, so a limit can't be applied (#3253). `session` is the seat's session name, for a
   *  placement not yet claimed by its node (before the seat's first launch). */
  seatInEnvironmentGuest?: (nodeId: string, session?: string) => boolean;

  /** Reads /proc and /sys for the limit's readback, and a launch's scope marker; replaceable in tests. */
  procRead: (path: string) => Promise<string> = (path) => fsReadFile(path, "utf8");
  readWindowsSeatJobForPane: typeof readWindowsSeatJobForPane = readWindowsSeatJobForPane;

  /** An executable's absolute path from the daemon's PATH (absolute entries only), or null; replaceable in tests. */
  resolveExecutable: (name: string) => string | null = (name) => {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      if (!pathIsAbsolute(dir)) continue;
      const candidate = pathJoin(dir, name);
      try { accessSync(candidate, fsConstants.X_OK); return candidate; } catch { /* not here */ }
    }
    return null;
  };

  /** Whether a directory exists; replaceable in tests. */
  dirExists: (path: string) => boolean = (path) => {
    try { return statSync(path).isDirectory(); } catch { return false; }
  };

  /** systemd-run's options proven by a throwaway scope, per systemd-run binary and pair of limits (memoized on success
   *  only). */
  private seatScopeProven = new Map<string, { literal: boolean; oomPolicy: boolean }>();
  /** The last check that failed without a positive answer (a timeout, an empty probe, an error not recognized), and when,
   *  per step ("bus", or the probe of one tasks_max and memory_max pair): a launch within SEAT_SCOPE_RETRY_MS reads it
   *  as `unverified`, with its age, never as a fresh result; the first launch after that asks again. A positive answer is
   *  not cached: every launch asks again, so a setup fixed since is seen at once. */
  private seatScopeFailedAt = new Map<string, { at: number; problem: SeatProcessLimitsProblem }>();
  /** The last positive inability, for the status only (as `unsupported`, with its age, for SEAT_SCOPE_RETRY_MS). */
  private seatScopeLastPositive?: { at: number; problem: SeatProcessLimitsProblem; probed: SeatProcessLimits };

  /** A seat's limits, or the reason its stored value can't be read (kept local to this seat). */
  private seatLimitsLookup(nodeId: string): { limits: SeatProcessLimits } | { invalid: string } | undefined {
    try {
      const limits = this.seatProcessLimits?.(nodeId);
      // A value with neither limit is no request (the stored value's parse refuses it anyway).
      return limits && (limits.tasksMax !== undefined || limits.memoryMax !== undefined) ? { limits } : undefined;
    } catch (error) {
      return { invalid: (error as Error).message };
    }
  }

  /** Whether a seat has a process limits request (a malformed stored one included). */
  seatProcessLimitsSet(nodeId: string): boolean {
    return this.seatLimitsLookup(nodeId) !== undefined;
  }

  /** The launch policy, read once by each launch or check: undefined when the daemon gives seats none, or what reading it
   *  threw. */
  private readLaunchPolicy(): SeatLaunchPolicy | Error | undefined {
    if (!this.launchEnvironment) return undefined;
    try { return this.launchEnvironment(); } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
  }

  /** For a seat with a limit, the structured warning of a recovery that keeps a running process whose readback is not
   *  `applied` (a restart in place that types into its shell), or null (no limit, or applied). Read only. */
  async seatProcessLimitsNotApplied(nodeId: string, paneTarget: string): Promise<SeatProcessLimitsNotice | null> {
    const lookup = this.seatLimitsLookup(nodeId);
    if (!lookup) return null;
    if ("invalid" in lookup) return notAppliedNotice({ kind: "invalid", reason: lookup.invalid });
    const report = await this.readSeatProcessLimits(paneTarget, lookup.limits, nodeId);
    if (report.state === "applied") return null;
    const requested = { ...lookup.limits };
    // The restart keeps this process: a readback that failed can't say whether it is under the limit.
    if (report.state === "unknown") {
      return unknownNotice({ kind: "unverified", requested,
        reason: `a restart in place keeps the running process, and whether it is under the limit can't be read back` +
          `${report.reason ? `: ${report.reason}` : ""}` });
    }
    // Known not under the limit is the path's (a fresh launch applies it), and a host that can't make the scope is that.
    return notAppliedNotice({ kind: report.state === "unsupported" ? "unsupported" : "setup",
      reason: `a restart in place keeps the running process, and it is ${report.state === "not_applied" ? "not under the limit" : report.state}` +
        `${report.reason ? `: ${report.reason}` : ""}; a fresh launch applies the limit`,
      requested });
  }

  /** The path a recovery of this seat takes, chosen before anything is stopped (#3253): null when it gets its limit,
   *  or the warning it will go ahead with. A recovery never stops for a limit; the respawn it then runs in "recovery"
   *  mode never refuses for one either (a scope failure late in the path also ends in this warning). */
  async seatProcessLimitsRecoveryPlan(nodeId: string): Promise<SeatProcessLimitsNotice | null> {
    const lookup = this.seatLimitsLookup(nodeId);
    if (!lookup) return null;
    if ("invalid" in lookup) return notAppliedNotice({ kind: "invalid", reason: lookup.invalid });
    const outcome = await this.seatScope(lookup.limits, { OPENRIG_NODE_ID: nodeId }, this.readLaunchPolicy());
    return outcome.ok ? null : notAppliedNotice(outcome.problem);
  }

  /** For a restart in place that respawns a bare pane (no seat environment), chosen before anything is stopped (#3253):
   *  null when the seat has no limit; `keep` when its running process reads back as under the limit and a new scope can
   *  be made now (respawnPane with `keepLimitOf` then starts the command in one); otherwise the warning the restart goes
   *  ahead with. Read only, apart from the scope check. */
  async seatProcessLimitsKeepPlan(nodeId: string, paneTarget: string):
    Promise<{ keep: true } | { keep: false; notice: SeatProcessLimitsNotice } | null> {
    const lookup = this.seatLimitsLookup(nodeId);
    if (!lookup) return null;
    if ("invalid" in lookup) return { keep: false, notice: notAppliedNotice({ kind: "invalid", reason: lookup.invalid }) };
    const requested = { ...lookup.limits };
    const report = await this.readSeatProcessLimits(paneTarget, lookup.limits, nodeId);
    if (report.state === "applied") {
      const outcome = await this.seatScope(lookup.limits, { OPENRIG_NODE_ID: nodeId }, this.readLaunchPolicy());
      if (outcome.ok) return { keep: true };
      return { keep: false, notice: notAppliedNotice({ ...outcome.problem,
        reason: `the seat runs under its limit, but a restart in place respawns it in a new scope, and ${outcome.problem.reason}` }) };
    }
    // The respawned process is known not to be under the limit: only a limit read back as applied is kept.
    const why = report.state === "unknown" ? "its limit can't be read back"
      : report.state === "unsupported" ? "this host can't make the scope" : "it is not under the limit";
    return { keep: false, notice: notAppliedNotice({
      kind: report.state === "unsupported" ? "unsupported" : report.state === "unknown" ? "unverified" : "setup",
      reason: `a restart in place respawns a bare pane and keeps only a limit that reads back as applied; ${why}` +
        `${report.reason ? ` (${report.reason})` : ""}; a fresh launch applies it`,
      requested }) };
  }

  /** The user manager's runtime directory: XDG_RUNTIME_DIR when absolute, else /run/user/<uid> when it exists. */
  private scopeRuntimeDir(): string | undefined {
    const own = seatRuntimeDir(process.env);
    if (own !== undefined) return own;
    const uid = process.getuid?.();
    if (uid === undefined) return undefined;
    const fallback = `/run/user/${uid}`;
    return this.dirExists(fallback) ? fallback : undefined;
  }

  /** Why this host (`unsupported`) or this setup (`setup`) positively can't give a seat its own scope, read from the
   *  environment only, or null. Unlike the server's scope (userScopeUnavailable), a daemon that is not a systemd user
   *  service can still ask the user manager for a seat scope: MANAGERPID unset is no proof, the probe decides. */
  private seatScopeStaticProblem(policy: SeatLaunchPolicy | Error | undefined, nodeId?: string, session?: string): SeatProcessLimitsProblem | null {
    if (nodeId && this.seatInEnvironmentGuest?.(nodeId, session)) {
      return { kind: "setup", reason: "the seat runs in an environment guest; its processes are outside this host's scope" };
    }
    if (process.platform !== "linux") return { kind: "unsupported", reason: "not Linux" };
    if (this.scopeRuntimeDir() === undefined) {
      return { kind: "setup", reason: `XDG_RUNTIME_DIR is unset and /run/user/${process.getuid?.() ?? "<uid>"} does not exist: ` +
        "start the daemon with XDG_RUNTIME_DIR set, or as a systemd user service" };
    }
    if (policy instanceof Error) return { kind: "unverified", reason: `the launch environment can't be read: ${policy.message}` };
    if (!policy) return { kind: "setup", reason: "this daemon gives seats no launch environment" };
    if (policy.inheritTmuxEnvironment) {
      // A seat scope is set up by systemd-run, which needs the user bus settings in its own environment; the scoped
      // launch environment then rebuilds the seat's exact environment around it. With the inherited tmux environment
      // there is no such rebuild, and the seat would start with systemd-run's bus settings instead of its own.
      return { kind: "setup", reason: INHERIT_TMUX_ENVIRONMENT_REASON };
    }
    return null;
  }

  /** systemd-run, systemctl and timeout, resolved once from the daemon's PATH, or why they can't be. */
  private seatScopeTools(): SeatScopeTools | { problem: SeatProcessLimitsProblem } {
    const systemdRun = this.resolveExecutable("systemd-run");
    const systemctl = this.resolveExecutable("systemctl");
    if (!systemdRun || !systemctl) {
      return { problem: { kind: "unsupported",
        reason: `${!systemdRun ? "systemd-run" : "systemctl"} is not in the daemon's PATH (${process.env.PATH ?? ""})` } };
    }
    const timeout = this.resolveExecutable("timeout");
    if (!timeout) {
      return { problem: { kind: "setup", reason: "coreutils' timeout is not in the daemon's PATH: install it, or start the " +
        "daemon with a PATH that has it" } };
    }
    return { systemdRun, systemctl, timeout };
  }

  /** The prefix that starts a seat's pane command in a systemd user scope of its own with TasksMax and/or MemoryMax:
   *  the tmux server stays where it is, and only this seat's processes are under the limits (#3253). systemd-run
   *  registers itself in the new scope and then execs the command, so the pane's process is the seat's. Or why it
   *  can't, classified: never a silent start without the limit. */
  private async seatScope(limits: SeatProcessLimits, seatEnv: Record<string, string>, policy: SeatLaunchPolicy | Error | undefined):
    Promise<{ ok: true; prefix: string[] } | { ok: false; problem: SeatProcessLimitsProblem }> {
    const requested = { ...limits };
    const fail = (problem: SeatProcessLimitsProblem) => ({ ok: false as const, problem: { ...problem, requested } });
    const positive = (problem: SeatProcessLimitsProblem) => {
      if (problem.kind === "unsupported") this.seatScopeLastPositive = { at: Date.now(), problem, probed: limits };
      return fail(problem);
    };
    const fixed = this.seatScopeStaticProblem(policy, seatEnv.OPENRIG_NODE_ID, seatEnv.OPENRIG_SESSION_NAME);
    if (fixed) {
      if (process.platform === "win32" && fixed.kind === "unsupported") {
        if (limits.tasksMax !== undefined) return positive({ kind: "unsupported", limit: "tasks_max",
          reason: "Windows Job active-process limits do not enforce the requested process-and-thread task count" });
        if (policy instanceof Error) return fail({ kind: "unverified", reason: `the launch environment can't be read: ${policy.message}` });
        if (!policy) return fail({ kind: "setup", reason: "this daemon gives seats no launch environment" });
        if (policy.inheritTmuxEnvironment) return fail({ kind: "setup", reason: INHERIT_TMUX_ENVIRONMENT_REASON });
        // Actual Job creation and readback are fenced at the launch boundary.
        return { ok: true, prefix: [] };
      }
      return positive(fixed);
    }
    const tools = this.seatScopeTools();
    if ("problem" in tools) return positive(tools.problem);
    const runtimeDir = this.scopeRuntimeDir()!;
    // A systemd-run that changed since (another PATH, an upgrade) is proven again, and so is each pair of limits: a
    // memory limit is never taken as proven by a scope that had only the task limit.
    const provenKey = `${tools.systemdRun}\0${limits.tasksMax ?? "-"}\0${limits.memoryMax ?? "-"}`;
    const probeKey = `probe:${provenKey}`;
    for (const key of ["bus", probeKey]) {
      const failed = this.seatScopeFailedAt.get(key);
      if (failed && Date.now() - failed.at < SEAT_SCOPE_RETRY_MS && (key === "bus" || !this.seatScopeProven.has(provenKey))) {
        return fail({ kind: "unverified", reason: `the last check failed: ${failed.problem.reason}`,
          ageSeconds: Math.floor((Date.now() - failed.at) / 1000) });
      }
    }
    // Only a failure that says nothing either way is cached; a positive one is asked again at the next launch.
    const remember = (key: string, problem: SeatProcessLimitsProblem) => {
      if (problem.kind === "unverified") this.seatScopeFailedAt.set(key, { at: Date.now(), problem });
      return positive(problem);
    };
    // The bus at this launch, not at the first one: a manager that went away since must not start the seat unlimited.
    try {
      await this.exec(posixJoinArgv([...seatScopeBusEnv(runtimeDir), tools.timeout, "5",
        tools.systemctl, "--user", "show", "--property=Version", "--value"]));
    } catch (error) {
      return remember("bus", classifyScopeFailure(error, "asking the systemd user manager"));
    }
    this.seatScopeFailedAt.delete("bus");
    let opts = this.seatScopeProven.get(provenKey);
    if (!opts) {
      const proven = await this.proveSeatScope(runtimeDir, limits, tools);
      if (!proven.ok) return remember(probeKey, proven.problem);
      opts = proven.opts;
      this.seatScopeProven.set(provenKey, opts);
    }
    this.seatScopeFailedAt.delete(probeKey);
    this.seatScopeLastPositive = undefined;
    const name = seatEnv.OPENRIG_SESSION_NAME || seatEnv.OPENRIG_NODE_ID || "seat";
    // Unit names take ASCII letters, digits and ":-_.\\"; an "@" would read as a template instance.
    const unit = `openrig-seat-${name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120)}-${randomUUID().slice(0, 8)}`;
    return { ok: true, prefix: [...seatScopeBusEnv(runtimeDir),
      ...seatScopeArgv(opts, unit, `OpenRig seat ${name}`, limits, tools.systemdRun), "--"] };
  }

  /** One throwaway scope with the seat's own options, whose command prints the pids.max of its own cgroup (and, with
   *  memory_max, its memory.max: one line per limit): the limits count as supported only when each one requested is the
   *  requested value. Options this systemd lacks are dropped from its stderr, as for the server's scope. A pids.max or
   *  memory.max that is another value (e.g. "max": TasksMax or MemoryMax= accepted but the controller not delegated) is a
   *  positive inability; an empty result or an error not recognized is unverified. */
  private async proveSeatScope(runtimeDir: string, limits: SeatProcessLimits, tools: SeatScopeTools):
    Promise<{ ok: true; opts: { literal: boolean; oomPolicy: boolean } } | { ok: false; problem: SeatProcessLimitsProblem }> {
    const opts = { literal: true, oomPolicy: true };
    const tasksMax = limits.tasksMax;
    // Shell builtins only: no fork inside the scope, so even TasksMax=1 can be proven (the probe is the scope's one task).
    const readOwnPidsMax = 'p=; while IFS= read -r l; do case $l in 0::*) p=${l#0::};; esac; done < /proc/self/cgroup; ' +
      'if [ -z "$p" ]; then printf "nocgroup2\\n"; elif [ ! -e "/sys/fs/cgroup$p/pids.max" ]; then printf "nopids\\n"; ' +
      'else IFS= read -r m < "/sys/fs/cgroup$p/pids.max" && printf "%s\\n" "$m"; fi';
    // With memory_max, the same builtins print one line per requested limit: `memory <memory.max|nomemory>`, then
    // `pids <pids.max|nopids>` when tasks_max is requested too (a seat without tasks_max has its user manager's own
    // pids.max, which is not judged).
    const readOwnLimits = 'p=; while IFS= read -r l; do case $l in 0::*) p=${l#0::};; esac; done < /proc/self/cgroup; ' +
      'if [ -z "$p" ]; then printf "nocgroup2\\n"; else ' +
      'if [ ! -e "/sys/fs/cgroup$p/memory.max" ]; then printf "memory nomemory\\n"; ' +
      'else IFS= read -r m < "/sys/fs/cgroup$p/memory.max" && printf "memory %s\\n" "$m"; fi; ' +
      (tasksMax !== undefined ? 'if [ ! -e "/sys/fs/cgroup$p/pids.max" ]; then printf "pids nopids\\n"; ' +
        'else IFS= read -r t < "/sys/fs/cgroup$p/pids.max" && printf "pids %s\\n" "$t"; fi; ' : '') +
      'fi';
    for (;;) {
      let out: string;
      try {
        out = await this.exec(posixJoinArgv([...seatScopeBusEnv(runtimeDir), tools.timeout, "10",
          ...seatScopeArgv(opts, `openrig-seat-probe-${randomUUID().slice(0, 8)}`, "OpenRig seat scope probe", limits, tools.systemdRun),
          "--", "/bin/sh", "-c", limits.memoryMax === undefined ? readOwnPidsMax : readOwnLimits]));
      } catch (error) {
        const stderr = execStderrText(error);
        if (opts.literal && NO_EXPAND_ENVIRONMENT.test(stderr)) { opts.literal = false; continue; }
        if (opts.oomPolicy && NO_OOM_POLICY.test(stderr)) { opts.oomPolicy = false; continue; }
        // The probe command ended with SIGKILL (the signal, or exit 137 from timeout or a shell) under a memory limit.
        // That does not say which process died nor why (the OOM killer at that MemoryMax=, the host's OOM killer,
        // systemd-oomd, a manual kill, or before the scope was entered), and the scope that could tell (its memory.events
        // `oom`) is collected with it. So it says only what was seen, names the limit and stays retryable (unverified).
        const sigkill = sigkillSeen(error);
        if (limits.memoryMax !== undefined && sigkill !== null) {
          return { ok: false, problem: { kind: "unverified", limit: "memory_max",
            reason: `the probe command ${sigkill} under the requested MemoryMax=${limits.memoryMax}; ` +
              "the process and the cause aren't confirmed; a larger memory_max may help" } };
        }
        return { ok: false, problem: classifyScopeFailure(error, "a throwaway seat scope") };
      }
      const got = out.trim();
      if (limits.memoryMax !== undefined) {
        const problem = scopeProbeProblem(got, limits);
        return problem ? { ok: false, problem } : { ok: true, opts };
      }
      if (!got) return { ok: false, problem: { kind: "unverified", reason: "a throwaway seat scope read no pids.max" } };
      if (got === "nocgroup2") return { ok: false, problem: { kind: "unsupported", reason: NO_CGROUP2 } };
      if (got === "nopids") {
        return { ok: false, problem: { kind: "unsupported", reason: "a throwaway seat scope has no pids.max: the pids controller is not delegated to the user manager" } };
      }
      // Only a readable limit that isn't the one asked for is a positive answer; anything else can't be read.
      if (!/^(\d+|max)$/.test(got)) {
        return { ok: false, problem: { kind: "unverified", reason: `a throwaway seat scope's pids.max read could not be understood ("${got.slice(0, 80)}")` } };
      }
      if (got !== String(tasksMax)) {
        return { ok: false, problem: { kind: "unsupported",
          reason: `a throwaway seat scope got pids.max "${got}" for TasksMax=${tasksMax}: the pids limit is not enforced here (is the pids controller delegated to the user manager?)` } };
      }
      return { ok: true, opts };
    }
  }

  /** Sleep used by the start check; replaceable in tests. */
  scopeStartSleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A new marker file for a capped launch, written "pending" (only this daemon creates it, exclusively): the command
   *  that runs first inside the scope empties it (scopeMarkArgv). */
  private async scopeMarker(): Promise<string> {
    const marker = this.fileOps.tmpName();
    await this.fileOps.writeFile(marker, SCOPE_MARKER_PENDING, { mode: 0o600, flag: "wx" });
    return marker;
  }

  /** Whether a capped launch's command has started inside its scope, from its marker: `ran` (emptied), `pending`, or
   *  `unreadable`. */
  private async scopeMarkerState(marker: string | undefined): Promise<"ran" | "pending" | "unreadable"> {
    if (!marker) return "unreadable";
    try {
      const text = await this.procRead(marker);
      return (process.platform === "win32" ? /^started\|[1-9]\d*$/.test(text) : text === "") ? "ran"
        : text === SCOPE_MARKER_PENDING ? "pending" : "unreadable";
    } catch {
      return "unreadable";
    }
  }

  /** Whether a capped launch's seat scope started: `started` once its command started inside the scope (the marker is
   *  emptied) and the pane's process is in a seat scope; `failed_before_command` when the pane died with the marker still
   *  pending (systemd-run could not make the scope, also late, after the check passed); `ran_and_ended` when it died
   *  after the command started inside the scope; `ran_unconfirmed` when the command started (the marker was emptied)
   *  but its process wasn't seen in the scope in time; `unknown` when the time ran out with the pane alive (its wrapper
   *  can still enter the scope and start the command after the last look) or the pane or the marker can't be read.
   *  The marker is removed at the end. */
  private async seatScopeStart(pane: string, marker: string | undefined, requested?: SeatProcessLimits):
    Promise<"started" | "failed_before_command" | "ran_and_ended" | "ran_unconfirmed" | "unknown"> {
    let sawRan = false;
    const deadline = Date.now() + SEAT_SCOPE_START_CHECKS * SEAT_SCOPE_START_CHECK_MS;
    try {
      for (let i = 0; i < SEAT_SCOPE_START_CHECKS; i++) {
        if (Date.now() >= deadline) break;
        let dead: boolean;
        try { dead = await this.isPaneDead(pane); } catch { return sawRan ? "ran_unconfirmed" : "unknown"; }
        const mark = await this.scopeMarkerState(marker);
        if (mark === "ran") sawRan = true;
        // A Windows guardian can die after creating a suspended child but
        // before publishing its receipt. Never replay that uncertain start.
        if (dead) return mark === "ran" ? "ran_and_ended" : process.platform === "win32" ? "unknown"
          : mark === "pending" ? "failed_before_command" : sawRan ? "ran_unconfirmed" : "unknown";
        if (mark === "ran") {
          try {
            const pid = await this.getPanePid(pane);
            if (process.platform === "win32") {
              if (pid !== null && marker) {
                const receipt = /^started\|([1-9]\d*)$/.exec(await this.procRead(marker));
                if (receipt) {
                  const read = await this.readWindowsSeatJobForPane(pid, { targetPid: Number(receipt[1]) });
                  if (read.activeProcesses > 0 && read.memoryMax === requested?.memoryMax && await this.getPanePid(pane) === pid) return "started";
                }
              }
              await this.scopeStartSleep(SEAT_SCOPE_START_CHECK_MS);
              continue;
            }
            const path = pid === null ? null : cgroupV2Path(await this.procRead(`/proc/${pid}/cgroup`));
            if (path && /\/openrig-seat-[^/]+\.scope$/.test(path)) return "started";
          } catch { /* not readable at this moment: look again */ }
        }
        await this.scopeStartSleep(SEAT_SCOPE_START_CHECK_MS);
      }
      // Out of time with the pane alive: the wrapper may enter its scope and start the command after the last look.
      return sawRan ? "ran_unconfirmed" : "unknown";
    } finally {
      if (marker) await this.fileOps.unlink(marker).catch(() => {});
    }
  }

  /** The seat scope a pane's process runs in, read from the kernel: unknown when it can't be read, outside a seat scope,
   *  or in one, with the files of the limits requested only: for tasks_max, its pids.max, pids.current and how many
   *  times a fork hit the limit (pids.events `max`); for memory_max, its memory.max, memory.current, how many times its
   *  usage was about to go over the limit (memory.events `max`) and how many of its processes an OOM killer killed (memory.events `oom_kill`). */
  private async readPaneScope(paneTarget: string, requested: SeatProcessLimits): Promise<
    | { at: "unknown"; reason: string; scope?: string }
    | { at: "outside"; scope: string }
    | { at: "seat"; scope: string; pidsMax?: string; pidsCurrent?: number; limitHits?: number;
      memoryMax?: string; memoryCurrent?: number; memoryLimitHits?: number; oomKills?: number }> {
    const pid = await this.getPanePid(paneTarget);
    if (pid === null) return { at: "unknown", reason: "the seat's pane process is not readable (not running?)" };
    let path: string | null;
    try { path = cgroupV2Path(await this.procRead(`/proc/${pid}/cgroup`)); }
    catch (error) { return { at: "unknown", reason: `cgroup unreadable: ${(error as Error).message}` }; }
    if (!path) return { at: "unknown", reason: "no cgroup v2 path for the seat's process" };
    const scope = path.split("/").pop() ?? "";
    if (!/^openrig-seat-.+\.scope$/.test(scope)) return { at: "outside", scope };
    try {
      const dir = `/sys/fs/cgroup${path}`;
      let pids = {};
      if (requested.tasksMax !== undefined) {
        const pidsMax = (await this.procRead(`${dir}/pids.max`)).trim();
        const pidsCurrent = Number((await this.procRead(`${dir}/pids.current`)).trim());
        const hits = /^max (\d+)$/m.exec(await this.procRead(`${dir}/pids.events`));
        pids = { pidsMax, pidsCurrent, limitHits: hits ? Number(hits[1]) : 0 };
      }
      let memory = {};
      if (requested.memoryMax !== undefined) {
        const memoryMax = (await this.procRead(`${dir}/memory.max`)).trim();
        const memoryCurrent = Number((await this.procRead(`${dir}/memory.current`)).trim());
        const events = await this.procRead(`${dir}/memory.events`);
        const hits = /^max (\d+)$/m.exec(events);
        const kills = /^oom_kill (\d+)$/m.exec(events);
        memory = { memoryMax, memoryCurrent, memoryLimitHits: hits ? Number(hits[1]) : 0, oomKills: kills ? Number(kills[1]) : 0 };
      }
      return { at: "seat", scope, ...pids, ...memory };
    } catch (error) {
      return { at: "unknown", scope, reason: `scope files unreadable: ${(error as Error).message}` };
    }
  }

  /** Where a seat's limits stand, read back from its pane's process (#3253): its cgroup must be a seat scope whose
   *  pids.max and memory.max are the requested values (each one requested). pids.events `max` counts the forks the
   *  limit refused; memory.events `max` the times usage was about to go over the memory limit, and `oom_kill` the processes in the scope any OOM killer killed.
   *  `paneTarget` is the seat's pane id (`%N`) when known, else its session (whose active pane is read). With `nodeId`, a
   *  seat in an environment guest reads `not_applied` (its pane holds only a local viewer). Read only. */
  async readSeatProcessLimits(paneTarget: string, requested: SeatProcessLimits, nodeId?: string): Promise<SeatProcessLimitsReport> {
    const base = { requested: { ...requested } };
    const policy = this.readLaunchPolicy();
    // The running process is read first: a seat already under its limit reads `applied` whatever this daemon could
    // create now. A seat not under it reads `unsupported` only on a positive inability (from the environment, or the
    // last check's own positive answer, with its age); else `not_applied` ("requested, not applied").
    const fixed = this.seatScopeStaticProblem(policy, nodeId);
    // A guest seat's pane holds only a local viewer: its readback says nothing of the agent's processes.
    if (nodeId && this.seatInEnvironmentGuest?.(nodeId)) return { ...base, state: "not_applied", reason: fixed!.reason };
    if (process.platform === "win32") {
      if (requested.tasksMax !== undefined) return { ...base, state: "unsupported",
        reason: "Windows Job active-process limits do not enforce the requested process-and-thread task count" };
      try {
        const pid = await this.getPanePid(paneTarget);
        if (pid === null) throw new Error("the seat pane process is unavailable");
        const read = await this.readWindowsSeatJobForPane(pid);
        if (await this.getPanePid(paneTarget) !== pid) throw new Error("the seat pane changed during readback");
        if (read.activeProcesses === 0) throw new Error("the seat Job has no active processes");
        if (read.memoryMax !== requested.memoryMax) return { ...base, state: "not_applied", memoryAccounting: "job_commit",
          memoryMax: String(read.memoryMax), reason: "the Job commit limit differs from the requested memory limit" };
        return { ...base, state: "applied", memoryAccounting: "job_commit", memoryMax: String(read.memoryMax) };
      } catch {
        return { ...base, state: "unknown", reason: "Windows seat Job, guardian or target membership could not be verified; no applied limit is claimed" };
      }
    }
    // The last positive answer counts only for a request that asks a limit it was about: a failed memory probe says
    // nothing of a tasks-only seat (nor a pids answer of a memory-only one); no cgroup v2 is about every limit.
    const recent = this.seatScopeLastPositive && Date.now() - this.seatScopeLastPositive.at < SEAT_SCOPE_RETRY_MS
      ? this.seatScopeLastPositive : undefined;
    const last = recent && inabilityLimits(recent.problem, recent.probed)
      .some((k) => (k === "tasks_max" ? requested.tasksMax : requested.memoryMax) !== undefined) ? recent : undefined;
    const unsupported = fixed?.kind === "unsupported" ? fixed.reason
      : last ? `${last.problem.reason}, observed ${Math.floor((Date.now() - last.at) / 1000)}s ago` : null;
    const notUnder = (reason: string): SeatProcessLimitsReport =>
      unsupported ? { ...base, state: "unsupported", reason: `${reason}; and this host can't make the scope: ${unsupported}` }
        : fixed ? { ...base, state: "not_applied", reason: `${reason}; and this setup can't make the scope: ${fixed.reason}` }
        : { ...base, state: "not_applied", reason };
    const read = await this.readPaneScope(paneTarget, requested);
    if (read.at === "unknown") return { ...base, state: "unknown", ...(read.scope ? { scope: read.scope } : {}), reason: read.reason };
    if (read.at === "outside") {
      return notUnder(`the seat's process is not in a seat scope (${read.scope}); the limit applies at its next fresh launch`);
    }
    const { at: _at, ...scopeRead } = read;
    // Applied only when every requested limit reads back as its value; the reason names each one that doesn't.
    const off = [
      ...(requested.tasksMax !== undefined && read.pidsMax !== String(requested.tasksMax)
        ? [`pids.max is ${read.pidsMax}, not ${requested.tasksMax}`] : []),
      ...(requested.memoryMax !== undefined && read.memoryMax !== String(requested.memoryMax)
        ? [`memory.max is ${read.memoryMax}, not ${requested.memoryMax}`] : []),
    ];
    return off.length === 0
      ? { ...base, state: "applied", ...scopeRead }
      : { ...base, state: "not_applied", ...scopeRead, reason: `${off.join("; ")}; the limit applies at its next fresh launch` };
  }

  /** Reset before the selected user shell runs, without changing the server or other sessions.
   * Multiple tmux command arguments execute directly; only this fixed non-interactive sh runs
   * before env -i. Generated pane metadata must come from this spawn, never daemon TMUX values.
   * Keep the configured default-command and default-shell lookup, including rc functions.
   */
  private async scopedLaunchCommand(seatEnv: Record<string, string>, command?: string, warnings: string[] = [],
    limitsMode: ProcessLimitsMode = "fresh", notices?: ScopeNotices, staged?: (file: string, recoveryEnv?: Record<string,string>) => void): Promise<string[] | null> {
    // #3253: a seat with a limit gets its scope. Where it can't: a fresh launch is not started and says why; a recovery
    // goes ahead without it, with a structured warning, and the request stays stored.
    const lookup = seatEnv.OPENRIG_NODE_ID ? this.seatLimitsLookup(seatEnv.OPENRIG_NODE_ID) : undefined;
    // Read once: the scope check and the launch below must see the same setting.
    const policy = seatEnv.OPENRIG_NODE_ID ? this.readLaunchPolicy() : undefined;
    let seatScope: string[] = [];
    let limited = false;
    const notApplied = (problem: SeatProcessLimitsProblem) => {
      if (limitsMode === "fresh") throw new SeatProcessLimitsNotApplied(problem);
      const notice = notAppliedNotice(problem);
      if (notices) { notices.processLimits = notice; notices.capped = false; }
      // Logged by the launch once it has gone on without the limit.
      warnings.push(noticeLine(notice));
      limited = false;
    };
    if (lookup) {
      if ("invalid" in lookup) notApplied({ kind: "invalid", reason: lookup.invalid });
      else if (notices?.failedStart) notApplied({ ...notices.failedStart, requested: { ...lookup.limits } });
      else {
        const outcome = await this.seatScope(lookup.limits, seatEnv, policy);
        if (outcome.ok) { seatScope = outcome.prefix; limited = true; }
        else notApplied(outcome.problem);
      }
    }
    if (!policy || !seatEnv.OPENRIG_NODE_ID) return null;
    if (!(policy instanceof Error) && policy.inheritTmuxEnvironment) {
      if (limited) notApplied({ kind: "setup", reason: INHERIT_TMUX_ENVIRONMENT_REASON, requested: { ...(lookup as { limits: SeatProcessLimits }).limits } });
      return null;
    }
    try {
      if (policy instanceof Error) throw policy;
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
        const marker = limited ? await this.scopeMarker() : undefined;
        let launch: ReturnType<typeof windowsScopedLaunch>;
        try {
          // A limited launch is one-shot: replaying the old loader would reuse
          // an already-consumed receipt without an OpenRig recovery decision.
          launch = windowsScopedLaunch(shell, command ?? "", selected, file, false, marker ? undefined : key,
            marker ? { memoryMax: (lookup as { limits: SeatProcessLimits }).limits.memoryMax!, marker } : undefined);
          await this.fileOps.writeFile(file, launch.content, { mode: 0o600, flag: "wx" });
        } catch (error) {
          if (marker) await this.fileOps.unlink(marker).catch(() => {});
          throw error;
        }
        if (marker && notices) { notices.capped = true; notices.marker = marker;
          notices.requested = { ...(lookup as { limits: SeatProcessLimits }).limits }; }
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
      // #3253: a seat with a limit enters its scope only after this file has run (its /bin/rm forks, outside the scope),
      // marks that its command started there, and gets back its own bus and runtime directory, which systemd-run's call
      // needed set otherwise.
      const marker = seatScope.length ? await this.scopeMarker() : undefined;
      const restore = seatScope.length ? [...scopeMarkArgv(marker!), ...restoreEnvArgv({
        DBUS_SESSION_BUS_ADDRESS: selected.DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR: selected.XDG_RUNTIME_DIR })] : [];
      if (notices) {
        notices.capped = seatScope.length > 0;
        if (marker) { notices.marker = marker; notices.requested = { ...(lookup as { limits: SeatProcessLimits }).limits }; }
      }
      return ["/bin/sh", "-c", reset, "sh", file, ...seatScope, ...restore, shell, ...(command ? ["-c", command] : ["-l"])];
    } catch (error) {
      if (limited) {
        notApplied({ kind: "unverified", reason: `the scoped launch environment failed: ${(error as Error).message}`,
          requested: { ...(lookup as { limits: SeatProcessLimits }).limits } });
      }
      // Keep the working launch, with a diagnostic; this option is not a new admission gate.
      const warning = "Scoped tmux environment unavailable; retaining the previous environment for this launch.";
      warnings.push(warning);
      console.warn(`[seat launch] ${warning}`);
      return null;
    }
  }

  /** A bare-pane respawn that keeps the seat's limit (a restart in place whose process reads back under it, #3253): the
   *  command runs as the pane's default shell would run it, inside a new seat scope, with the bus and runtime directory
   *  the pane would get from tmux. Recovery only: where the scope can't be made, the respawn goes on without it. */
  private async keptScopeCommand(nodeId: string, pane: string, command: string | undefined, warnings: string[],
    notices: ScopeNotices, staged?: (file: string) => void): Promise<string[] | null> {
    const lookup = this.seatLimitsLookup(nodeId);
    if (!lookup) return null;
    const notApplied = (problem: SeatProcessLimitsProblem): null => {
      const notice = notAppliedNotice(problem);
      notices.processLimits = notice;
      notices.capped = false;
      warnings.push(noticeLine(notice));
      return null;
    };
    if ("invalid" in lookup) return notApplied({ kind: "invalid", reason: lookup.invalid });
    const requested = { ...lookup.limits };
    if (notices.failedStart) return notApplied({ ...notices.failedStart, requested });
    const outcome = await this.seatScope(lookup.limits, { OPENRIG_NODE_ID: nodeId }, this.readLaunchPolicy());
    if (!outcome.ok) return notApplied(outcome.problem);
    try {
      if (!command) throw new Error("a kept scope needs the respawn's command");
      const shell = await this.getDefaultShell();
      if (!shell) throw new Error("Default shell unavailable");
      if (process.platform === "win32") {
        const marker = await this.scopeMarker(), file = this.fileOps.tmpName();
        try {
          const launch = windowsScopedLaunch(shell, command, {}, file, true, undefined, { memoryMax: requested.memoryMax!, marker });
          await this.fileOps.writeFile(file, launch.content, { mode: 0o600, flag: "wx" });
          staged?.(file); notices.capped = true; notices.marker = marker; notices.requested = requested;
          return ["--", ...launch.argv];
        } catch (error) {
          await this.fileOps.unlink(marker).catch(() => {});
          throw error;
        }
      }
      const restore = restoreEnvArgv({
        DBUS_SESSION_BUS_ADDRESS: await this.paneStartEnv(pane, "DBUS_SESSION_BUS_ADDRESS"),
        XDG_RUNTIME_DIR: await this.paneStartEnv(pane, "XDG_RUNTIME_DIR"),
      });
      const marker = await this.scopeMarker();
      notices.capped = true;
      notices.marker = marker;
      notices.requested = requested;
      return [...outcome.prefix, ...scopeMarkArgv(marker), ...restore, shell, "-c", command];
    } catch (error) {
      return notApplied({ kind: "unverified", reason: `the kept scope's launch could not be prepared: ${(error as Error).message}`, requested });
    }
  }

  /** The value a new process in this pane's session gets for `key` from tmux: the session's own (undefined when it is
   *  marked removed), else the server's global one. Throws when the environment can't be read. */
  private async paneStartEnv(pane: string, key: string): Promise<string | undefined> {
    const lines = await this.sessionEnvLines(pane);
    if (lines === null) throw new Error("Cannot read the session's launch environment.");
    if (lines.includes(`-${key}`)) return undefined;
    const own = lines.find((line) => line.startsWith(`${key}=`));
    if (own !== undefined) return own.slice(key.length + 1);
    return (await this.globalEnvironment())[key];
  }

  /** A launch's success result. A recovery that went on without the limit, or can't tell where it stands, is logged here,
   *  only once the launch has gone on. */
  private launched(warnings: string[], notices: ScopeNotices): TmuxResult {
    if (notices.processLimits) console.warn(`[seat launch] ${noticeLine(notices.processLimits)}`);
    return { ok: true, ...(warnings.length ? { warnings } : {}), ...(notices.processLimits ? { processLimits: notices.processLimits } : {}) };
  }

  /** After a capped launch made its pane: whether its scope started. A fresh launch counts only once it has (a command
   *  that started in the scope and ended counts too); otherwise it is refused as `unverified`, never retried without the
   *  limit. A recovery runs the command again without the limit only when it failed before the command started; when
   *  the start can't be told, it goes on with an `unknown` notice and runs nothing again. Null: the launch stands. */
  private async scopeStartOutcome(pane: string | null, mode: ProcessLimitsMode | undefined, notices: ScopeNotices,
    warnings: string[]): Promise<{ refuse: SeatProcessLimitsProblem } | { retryUncapped: SeatProcessLimitsProblem } | null> {
    // No pane to watch: whether its command started can't be told.
    const start = pane ? await this.seatScopeStart(pane, notices.marker, notices.requested) : "unknown";
    if (!pane && notices.marker) await this.fileOps.unlink(notices.marker).catch(() => {});
    if (start === "started") return null;
    const requested = notices.requested ? { requested: { ...notices.requested } } : {};
    const failedBefore = "the seat's scope did not start: its pane's command exited before entering it";
    if (mode !== "recovery") {
      if (start === "ran_and_ended") return null;
      if (start === "ran_unconfirmed") {
        return { refuse: { kind: "unverified", ...requested, commandStarted: true,
          reason: "the seat's command started, but its process was not seen in the seat's scope in time" } };
      }
      if (start === "unknown") {
        return { refuse: { kind: "unverified", ...requested, commandStarted: "unknown",
          reason: "the seat's scope start was not confirmed in time, so whether its command started is unknown" } };
      }
      // Only a pane that died with the marker still pending failed before the command.
      return { refuse: { kind: "unverified", ...requested, reason: failedBefore } };
    }
    if (start === "failed_before_command") return { retryUncapped: { kind: "unverified", reason: failedBefore } };
    // As in the fresh refusal: what was seen of the command, apart from the limit (nothing here is run again).
    const notice = unknownNotice({ kind: "unverified", ...requested, commandStarted: start === "unknown" ? "unknown" : true,
      reason: start === "ran_and_ended"
        ? "the seat's command started in its scope and ended before it was seen running; it was not run again"
        : start === "ran_unconfirmed"
          ? "the seat's command started, but its process was not seen in the seat's scope in time; it was not run again"
          : "the seat's scope start was not confirmed in time; the seat was not started again" });
    notices.processLimits = notice;
    warnings.push(noticeLine(notice));
    return null;
  }

  /** #3315: told what each classified probe of this adapter's server showed (reachable, or the no-server/socket
   *  diagnostic). The daemon records only changes (terminal-server-reachability.ts); an observer error never changes
   *  the probe's own result. */
  serverObserver?: (observation: TerminalServerObservation, startedIn?: number) => void;
  /** #3315: the epoch of this adapter's server record, read when a classified probe starts and handed back with its
   *  observation, so a probe that finishes after a newer loss or return can't overwrite it. */
  serverEpoch?: () => number;
  private readServerEpoch(): number | undefined {
    try { return this.serverEpoch?.(); } catch { return undefined; }
  }
  private noteServer(observation: TerminalServerObservation, startedIn?: number): void {
    try { this.serverObserver?.(observation, startedIn); } catch { /* reporting only */ }
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
    }, target => this.lastClientActivity(target.session));
  }

  /** When a writable tmux client attached to this session last had activity (epoch ms, whole seconds), or null when no
   *  writable client is attached. tmux's client_activity is session-wide and covers more than text keys, so this is
   *  recent writable-client activity, not proof of typing in the pane. A read-only client (a viewer tile) can't type
   *  into the seat and doesn't count. An attach counts: tmux can't tell a key in the attach's second from the attach,
   *  so a delivery can be held briefly after one. A tmux failure or an unreadable row throws: the guard then holds
   *  the paste rather than take it for "no activity" (#3076). */
  async lastClientActivity(session: string): Promise<number | null> {
    const exact = exactTarget(session, "session");
    const format = `#{client_readonly}${TMUX_FIELD_SEPARATOR}#{client_activity}`;
    const output = await this.run(["tmux", "list-clients", "-t", exact, "-F", format],
      `tmux list-clients -t ${shellQuote(exact)} -F "${format}"`);
    let latest: number | null = null;
    for (const line of output.split("\n").map(row => row.trim()).filter(row => row !== "")) {
      const [readonly, activity, ...rest] = line.split(TMUX_FIELD_SEPARATOR);
      if (rest.length || !/^[01]$/.test(readonly ?? "") || !/^[1-9]\d*$/.test(activity ?? "")) {
        throw new Error(`tmux list-clients: unreadable client row for ${session}`);
      }
      if (readonly === "0") latest = Math.max(latest ?? 0, Number(activity) * 1000);
    }
    return latest;
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
      await this.startServerBeforeImplicitStart();
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

  private async guardedInput(target: string, write: (pane: string, beforeWrite: () => void, nodeId?: string) => Promise<TmuxResult>, allowAbsent = false, inputKind: "control" | "text" | "keys" | "respawn" = "control"): Promise<TmuxResult> {
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
        return guard.input(identity, () => write(pane, () => guard.checkInput(identity), bound.nodeId));
      });
    } catch (error) {
      return { ok: false, code: (error as { code?: string }).code ?? "guard_target_unknown", message: String((error as Error).message),
        ...(error instanceof DeliveryGuardError && error.inputReadFailure ? { inputReadFailure: error.inputReadFailure } : {}) };
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

  /** psmux pane IDs are scoped to their session, so global pane batches are ambiguous. */
  get supportsPaneProcessBatch(): boolean { return this.terminalKind !== "psmux"; }

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

  private async nativePhysicalSession(physical: string, allowDead = false): Promise<NativePhysicalObservation> {
    try {
      if (!await this.nativeSessionExists(physical)) return {state:"absent"};
      const values = (await this.nativeRaw(["tmux","display-message","-p","-t",`=${physical}:`,
        `#{pid}|#{session_id}|#{session_created}|#{OPENRIG_NODE_ID}|#{OPENRIG_OCCUPANT_GENERATION}|#{${NATIVE_LOGICAL_SESSION_OPTION}}|#{session_windows}|#{window_panes}|#{pane_dead}|#{session_name}`])).trim().split("|");
      if (values.length !== 10 || values[6] !== "1" || values[7] !== "1" || !(allowDead ? /^[01]$/.test(values[8]!) : values[8] === "0") || values[9] !== physical
        || !/^[1-9]\d*$/.test(values[0]!) || !/^\$\d+$/.test(values[1]!) || !/^\d+$/.test(values[2]!)) return {state:"unknown"};
      return {state:"present",session:{serverPid:values[0]!,sessionId:values[1]!,sessionCreated:values[2]!,nodeId:values[3]!,generation:values[4]!,marker:values[5] || undefined}};
    } catch { return {state:"unknown"}; }
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
  /** #2710: the "no scope tried" reason is logged once per adapter, not at every server start. */
  private scopeSkipLogged = false;
  /** #3253: a server start in progress, so concurrent callers wait for it, the global environment's bus included. */
  private serverStarting?: Promise<TmuxResult>;
  /** #3253: the server may still hold the unusable bus in its global environment (this adapter's start ran past its
   *  wait or failed to give the bus back, or an earlier daemon process stopped before giving it back): the next
   *  startServer that finds it up gives it back first. True at first on Linux, so a restarted daemon checks once. */
  private sessionBusRestorePending = process.platform === "linux";

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
    if (this.terminalKind === "psmux") return this.runStockPrivateEnvironmentCommand(argv, protectedLaunch);
    const body = (legacy ?? posixJoinArgv(argv)).slice("tmux ".length) + "\n";
    // #3253: on Linux, a launch that may start the server waits for a start under way, which gives the panes the session
    // bus back before it settles: a pane made before that would keep the unusable address for its whole life. Checked
    // once the private config is written, right before the client runs, so a start another caller began meanwhile counts.
    const waitForStart = startServer && process.platform === "linux";
    const source = async (startFirst: boolean): Promise<string> => {
      const file = this.fileOps.tmpName();
      await this.fileOps.writeFile(file, body, { mode: 0o600, flag: "wx" });
      if (waitForStart && this.serverStarting) await this.serverStarting;
      try {
        const output = await this.run(["tmux", ...(startFirst ? ["start-server", ";"] : []), "source-file", file]);
        await this.fileOps.unlink(file).catch(() => {});
        return output;
      } catch (error) {
        // No server read it, so the private file was never consumed.
        if (!startFirst && isServerMissingError(error)) await this.fileOps.unlink(file).catch(() => {});
        throw error;
      }
    };
    if (!startServer || process.platform !== "linux") return source(startServer);
    // #2710, #3253: on Linux, `start-server` would start a missing server outside a user scope and with the daemon's
    // session bus in its own process. Try on the running server first; only when there is none, start it as startServer
    // does (in the user scope where one can be made, without a session bus) and run the command as before. While the bus
    // may still be owed (this daemon's first launch, as after a restart, or a give-back that failed), startServer runs
    // first, once, so the server's global environment is checked before this pane takes it.
    if (this.sessionBusRestorePending) await this.startServer();
    try {
      return await source(false);
    } catch (error) {
      if (!isServerMissingError(error)) throw error;
    }
    await this.startServer();
    return source(true);
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
    this.serverStarting ??= this.startServerOnce().finally(() => { this.serverStarting = undefined; });
    return this.serverStarting;
  }

  private async startServerOnce(): Promise<TmuxResult> {
    const probeName = `openrig-startup-${randomUUID()}`;
    const serverUp = async () => (await this.probeSession(probeName)).state !== "transport_unavailable";
    const awaitServer = async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (await serverUp()) return true;
      }
      return false;
    };
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
      if (await serverUp()) return this.sessionBusRestorePending ? await this.restoreSessionBusForPanes() : { ok: true };
      // #2710: on Linux, the server (and with it every seat) goes into a transient systemd --user scope of its own,
      // so stopping or restarting the daemon's unit no longer takes the seats with it. Any failure keeps the start below.
      this.sessionBusRestorePending = process.platform === "linux";
      if (await this.startServerInUserScope()) {
        if (await awaitServer()) return await this.restoreSessionBusForPanes();
        console.warn("[tmux] The systemd user scope was made but the seat terminal server did not answer in time; starting it in the daemon's cgroup as before.");
      }
      // tmux -D keeps an empty server alive. Stays on the shell-string path
      // deliberately: detach + stdio redirection have no argv equivalent,
      // and server bootstrap is POSIX-specific (psmux auto-starts its own).
      // Native socket ownership arbitrates
      // concurrent starts; the readback below, not shell exit, proves availability.
      await this.exec(this.onServer("tmux -D </dev/null >/dev/null 2>&1 &"));
      if (await awaitServer()) return await this.restoreSessionBusForPanes();
      return { ok: false, code: "tmux_unavailable", message: "The terminal server did not become available. Check tmux and its socket permissions." };
    } catch (error) {
      return { ok: false, code: "tmux_unavailable", message: `Terminal server unavailable: ${(error as Error).message}` };
    }
  }

  /** #3253: the server this start made has no session bus in its own process (TMUX_SERVER_NO_SESSION_BUS), and tmux
   *  copied that value into its global environment, which panes inherit. This gives the global environment the daemon's
   *  value back (or unsets it, as before the start), so a pane keeps the real session bus. Only while the global still
   *  holds OpenRig's own unusable address (TMUX_SERVER_SESSION_BUS), which only OpenRig's own starts set: a server
   *  another program started, or a value set since, is left as it is. The read and the write are two commands: a
   *  server-side check (`if-shell -F '#{==:#{DBUS_SESSION_BUS_ADDRESS},…}'`) reads the target
   *  session's environment before the global one, so on a server that already has a session with its own address (a
   *  retry) it would compare that one and leave the global as it is. The value goes in argv,
   *  unlike the seat environment (runEnvironmentCommand): a bus address is not a credential, and it was in the global
   *  environment before #3253 too. A failure is a warning, never a failed start, and the next startServer tries again.
   *  Panes and jobs the person's tmux configuration makes while the server starts (before this runs) keep no bus. */
  private async restoreSessionBusForPanes(): Promise<TmuxResult> {
    if (process.platform !== "linux") return { ok: true };
    const key = "DBUS_SESSION_BUS_ADDRESS";
    const real = process.env[key];
    try {
      if ((await this.globalEnvironment())[key] === TMUX_SERVER_SESSION_BUS) {
        await this.run(real === undefined ? ["tmux", "set-environment", "-gu", key] : ["tmux", "set-environment", "-g", key, real]);
      }
      this.sessionBusRestorePending = false;
    } catch (error) {
      console.warn(`[tmux] Could not give the new terminal server's panes the session bus back: ${(error as Error).message}`);
    }
    return { ok: true };
  }

  /** Linux only: run `tmux -D` as the command of a transient `systemd-run --user --scope`. systemd-run exits once the
   *  scope holds the backgrounded server, so its exit status says whether the scope was made. True when it was; false,
   *  with a log line giving the reason, when the start must fall back to the daemon's own cgroup. A start where no scope
   *  is tried (not a user service, no user manager) says why once per adapter, not at every server start. */
  private async startServerInUserScope(): Promise<boolean> {
    if (process.platform !== "linux") return false;
    const fallback = (reason: string) => {
      console.warn(`[tmux] Seat terminal server not in a systemd user scope (${reason}); starting it in the daemon's cgroup as before.`);
      return false;
    };
    const unavailable = this.userScopeUnavailable();
    if (unavailable) {
      if (this.scopeSkipLogged) return false;
      this.scopeSkipLogged = true;
      return fallback(unavailable);
    }
    // #3253: systemd-run itself needs the session bus (it reaches the manager through it or the runtime directory);
    // only the server inside the scope goes without.
    const server = TMUX_SERVER_LIMIT_PREFIX + TMUX_SERVER_NO_SESSION_BUS + posixJoinArgv(["tmux", ...this.serverArgs, "-D"]);
    // systemd-run 254+ expands ${VAR} in the command's arguments (by default from 258, also for --scope): the
    // socket path must reach /bin/sh exactly as given, so expansion is turned off where the option exists.
    const scoped = (oomPolicy: boolean, literal: boolean) => posixJoinArgv(["systemd-run", "--user", "--scope",
      "--quiet", "--collect", "--unit", `openrig-tmux-${randomUUID().slice(0, 8)}`,
      "--description", "OpenRig seat terminal server", ...(literal ? ["--expand-environment=no"] : []),
      // A scope's default OOM policy stops every process in it when the kernel OOM-kills one: one seat would take all.
      ...(oomPolicy ? ["-p", "OOMPolicy=continue"] : []),
      "--", "/bin/sh", "-c", `${server} </dev/null >/dev/null 2>&1 &`]);
    let oomPolicy = true;
    let literal = true;
    const dropped: string[] = [];
    for (;;) {
      try {
        await this.exec(scoped(oomPolicy, literal));
        if (!oomPolicy) {
          console.warn(`[tmux] Seat terminal server in a systemd user scope without OOMPolicy=continue (${dropped.join("; ")}).`);
        }
        return true;
      } catch (error) {
        const reason = execFailureReason(error);
        // Only systemd's own message on stderr drops an option: a timeout or an unknown failure echoes the whole
        // command (options included) in its message, and must fall back with the reason, not retry without them.
        const stderr = execStderrText(error);
        // systemd before 254 has no --expand-environment (and never expands): retry without it.
        if (literal && NO_EXPAND_ENVIRONMENT.test(stderr)) { literal = false; dropped.push(reason); continue; }
        // systemd before 253 has no OOMPolicy= for scopes: the scope is still worth having without it.
        if (oomPolicy && NO_OOM_POLICY.test(stderr)) { oomPolicy = false; dropped.push(reason); continue; }
        return fallback(reason);
      }
    }
  }

  /** Before a command that would start a missing server itself (new-session), start it the way startServer does, so that
   *  first start also lands in the systemd user scope where one can be made (#2710) and its server process gets no
   *  session bus (#3253). Linux only, with or without a user scope; elsewhere the caller's start stays. */
  private async startServerBeforeImplicitStart(): Promise<void> {
    if (process.platform === "linux") await this.startServer();
  }

  /** Why no systemd user scope is tried, or null. Only the environment is read. The scope is for a daemon that is itself
   *  a service of the systemd user manager (the manager sets MANAGERPID for its services; a process started by hand
   *  from a shell that inherited it, under such a service, also counts, which is harmless): restarting that unit no longer
   *  takes the seats along. A daemon started from a login session keeps its seats in that session, as before: there a
   *  scope under the user manager would die with it when the last session ends without lingering. */
  private userScopeUnavailable(): string | null {
    if (process.platform !== "linux") return "not Linux";
    // systemd-run --user reaches the user manager through $XDG_RUNTIME_DIR; without it there is none to ask.
    if (seatRuntimeDir(process.env) === undefined) return "no systemd user manager: XDG_RUNTIME_DIR is not an absolute path";
    if (!process.env.MANAGERPID) return "the daemon is not a systemd user service: MANAGERPID is unset";
    return null;
  }

  async listSessions(): Promise<TmuxSession[]> {
    const startedIn = this.readServerEpoch();
    try {
      const output = await this.run(["tmux", "list-sessions", "-F", SESSION_FORMAT],
        `tmux list-sessions -F "${SESSION_FORMAT}"`);
      this.noteServer({ reachable: true }, startedIn);
      return await Promise.all(parseLines(output, parseSessionLine).map(async session => ({ ...session, name: await this.nativeObservedName(session.name) })));
    } catch (err) {
      // Classified from what tmux reported (its stderr when the exec kept it), as probeSession does: the wrapper's
      // "Command failed:" line and stdout never decide it. Unknown and permission errors still throw the original.
      const error = tmuxReportedError(err);
      if (isNoServerError(error) || isTmuxTransportAbsentError(error)) {
        this.noteServer({ reachable: false, cause: serverDiagnostic(error) }, startedIn);
        return [];
      }
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

  /** When the tmux server holding a session started (`#{start_time}`, seconds since the epoch), or null when it can't
   *  be read. Pane ids are unique for the life of a server and repeat only after it restarts. */
  async serverStartTime(session: string): Promise<number | null> {
    const target = exactTarget(session, "session");
    try {
      const out = (await this.run(["tmux", "display-message", "-p", "-t", target, "#{start_time}"],
        `tmux display-message -p -t ${shellQuote(target)} '#{start_time}'`)).trim();
      return /^\d+$/.test(out) ? Number(out) : null;
    } catch {
      return null;
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
    const startedIn = this.readServerEpoch();
    try {
      // Use `tmux has-session` directly for reliable existence check — avoids
      // parsing format-string output from `list-sessions` which can fail when
      // tab delimiters are malformed across tmux versions.
      const target = `=${name}`; // canonical session name, never a prefix lookup
      await this.runNamedSession(["tmux", "has-session", "-t", target], name,
        `tmux has-session -t ${shellQuote(target)}`);
      this.noteServer({ reachable: true }, startedIn);
      return { state: "present" }; // exit 0 = session exists
    } catch (err) {
      const error = tmuxReportedError(err);
      // psmux's has-session returns an empty exit 1 for an absent session.
      // Spawn/permission/transport failures carry diagnostics or a different code.
      const native = err as { code?: unknown; stdout?: unknown; stderr?: unknown; signal?: unknown; killed?: boolean };
      if (this.terminalKind === "psmux" && native.code === 1 && native.stdout === "" && native.stderr === ""
        && !native.signal && !native.killed) return { state: "absent" };
      if (isSessionAbsenceError(error)) {
        this.noteServer({ reachable: true }, startedIn); // the server answered: the session is what is missing
        return { state: "absent" };
      }
      if (isNoServerError(error) || isTmuxTransportAbsentError(error)) {
        this.noteServer({ reachable: false, cause: serverDiagnostic(error) }, startedIn);
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

  async createSession(name: string, cwd?: string, env?: Record<string, string>, launchOpts?: { processLimitsMode?: ProcessLimitsMode }): Promise<TmuxResult> {
    const launchEnv = env === undefined ? undefined : { ...env };
    const nodeId = readPlatformEnv(launchEnv ?? {}, "OPENRIG_NODE_ID", this.isNativeWindows ? "win32" : "linux");
    if (this.deliveryGuard && (!nodeId || !this.deliveryGuard.ownsLifecycle(nodeId))) {
      return { ok: false, code: "guard_lease_required", message: "Managed launch requires a lifecycle lease before terminal creation." };
    }
    const result = await this.createSessionUnchecked(name, cwd, launchEnv, launchOpts);
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
      const source = await this.nativeBoundName(identity.staging), destination = await this.nativeBoundName(identity.canonical);
      const predecessor = await this.nativePhysicalSession(source,true), successor = await this.nativePhysicalSession(destination);
      const qualified = (value: NativePhysicalObservation, logical: string, physical: string, generation: string): value is {state:"present";session:NativePhysicalSession} =>
        value.state === "present" && value.session.nodeId === nodeId && value.session.generation === generation
        && value.session.marker === (physical === logical ? undefined : bindNativeSessionName(logical).marker);
      if (!qualified(predecessor,identity.staging,source,identity.predecessorGeneration)
        || !qualified(successor,identity.canonical,destination,identity.successorGeneration)) throw new Error("Native client-follow physical identities are not qualified");
      const same = (actual: NativePhysicalObservation, expected: NativePhysicalSession) => actual.state === "present"
        && (Object.keys(expected) as Array<keyof NativePhysicalSession>).every(key => actual.session[key] === expected[key]);
      const unchanged = async () => {
        if (await this.nativeBoundName(identity.staging) !== source || await this.nativeBoundName(identity.canonical) !== destination
          || !same(await this.nativePhysicalSession(source,true),predecessor.session)
          || !same(await this.nativePhysicalSession(destination),successor.session)) throw new Error("Native client-follow server or occupant changed");
      };
      const clients=async()=>{
        const output=await this.runNamedSession(["tmux","list-clients","-t",`=${identity.staging}`,"-F",CLIENT_FORMAT], identity.staging);
        const rows=parseLines(output,parseClientLine);
        if(output.split(/\r?\n/).filter(line=>line.trim()!=="").length!==rows.length)throw new Error("Native attached-client listing is malformed");
        // Client formats expose physical names. Decode only after verifying the
        // observed session's marker, as with the normal native inventory.
        for (const row of rows) row.session = await this.nativeObservedName(row.session);
        const rawCount=(await this.runNamedSession(["tmux","display-message","-p","-t",`=${identity.staging}:`,"#{session_attached}"], identity.staging, undefined, true)).trim();
        // Stock psmux reports this format as a boolean, unlike tmux's count.
        if(!/^\d+$/.test(rawCount) || (Number(rawCount)>0)!==(rows.length>0))throw new Error("Native attached-client observation changed or is incomplete");
        return rows;
      };
      const attached=await clients();
      if(attached.some(client=>client.session!==identity.staging))throw new Error("Native client listing contains an unexpected session");
      for(const client of attached){
        if(!backend.ownsLifecycle())throw new Error("Native exchange lifecycle lease was lost");
        await unchanged();
        const current = await backend.observe();
        if (current.canonical.state !== "present" || current.canonical.generation !== identity.successorGeneration
          || current.parking.state !== "absent") throw new Error("Native successor identity changed before client following");
        const refused=`openrig-native-client-refused-${randomUUID()}`;
        const fields = [["pid",predecessor.session.serverPid],["session_id",predecessor.session.sessionId],
          ["session_created",predecessor.session.sessionCreated],["OPENRIG_NODE_ID",nodeId],
          ["OPENRIG_OCCUPANT_GENERATION",identity.predecessorGeneration],[NATIVE_LOGICAL_SESSION_OPTION,predecessor.session.marker ?? ""],
          ["session_windows","1"],["window_panes","1"]];
        // The exact physical target selects the server. psmux does not implement
        // POSIX nested-format name escaping for literal hashes/braces.
        const condition=fields.map(([key,value])=>`#{==:#{${key}},${tmuxFormatLiteral(value!)}}`).reduce((left,right)=>`#{&&:${left},${right}}`);
        if(!backend.ownsLifecycle())throw new Error("Native exchange lifecycle lease was lost before client following");
        const output=await this.nativeRaw(["tmux","if-shell","-F","-t",`=${source}:`,condition,
          `switch-client -c ${shellQuote(client.name)} -t ${shellQuote(`=${destination}`)}`,`display-message -p ${refused}`]);
        if(output.includes(refused))throw new Error("Native predecessor identity changed before client following");
      }
      // The native client reconnects asynchronously. Do not retire a server
      // while it still owns an attached client, including a newly attached one.
      for(let attempt=0;attempt<20;attempt++){
        if((await clients()).length===0){
          await unchanged();
          const current=await backend.observe();
          if(current.canonical.state!=="present" || current.canonical.generation!==identity.successorGeneration
            || current.parking.state!=="absent")throw new Error("Native successor identity changed during client following");
          if(!backend.ownsLifecycle())throw new Error("Native exchange lifecycle lease was lost during client following");
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
    const physicalObserve = (physical: string) => this.nativePhysicalSession(physical);
    const physicalWrite = async (physical: string, expected: NativePhysicalSession, command: string): Promise<void> => {
      if (!ownsLifecycle()) throw new Error("Native exchange lifecycle lease was lost");
      const terms = [
        ["pid",expected.serverPid],["session_id",expected.sessionId],["session_created",expected.sessionCreated],
        ["OPENRIG_NODE_ID",expected.nodeId],["OPENRIG_OCCUPANT_GENERATION",expected.generation],
        [NATIVE_LOGICAL_SESSION_OPTION,expected.marker ?? ""],["session_windows","1"],["window_panes","1"],["pane_dead","0"],
      ].map(([key,value]) => `#{==:#{${key}},${tmuxFormatLiteral(value!)}}`);
      const condition = terms.reduce((left,right) => `#{&&:${left},${right}}`);
      const refused = `openrig-native-exchange-refused-${randomUUID()}`;
      const output = await this.nativeRaw(["tmux","if-shell","-F","-t",`=${physical}:`,condition,command,`display-message -p ${refused}`]);
      if (output.includes(refused)) throw new Error("Native exchange source occupant changed; no write was performed");
    };
    const transition = new NativeNameTransition(nodeId, {
      ownsLifecycle, observe:physicalObserve,
      rename: async (from,to,expected) => {
        if (await this.nativeSessionExists(to)) throw new Error("Native exchange destination is not proven absent");
        // This backend is psmux-only: rename-session stores the operand literally.
        // POSIX tmux's name-format escaping would persist doubled hashes here.
        await physicalWrite(from,expected,`rename-session -t ${shellQuote(`=${from}`)} ${shellQuote(to)}`);
      },
      writeMarker: async (physical,marker,expected) => physicalWrite(physical,expected,marker === undefined
        ? `set-option -u -t ${shellQuote(`=${physical}:`)} ${NATIVE_LOGICAL_SESSION_OPTION}`
        : `set-option -t ${shellQuote(`=${physical}:`)} ${NATIVE_LOGICAL_SESSION_OPTION} ${shellQuote(marker)}`),
    });
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
      prepareRename: async (from,to,generation) => {
        const names = [identity.canonical,identity.staging,identity.parking];
        if (!names.includes(from) || !names.includes(to)
          || ![identity.predecessorGeneration,identity.successorGeneration].includes(generation)) {
          throw new Error("Native exchange preparation is outside its custody");
        }
        return transition.prepare(from,to,generation);
      },
      resumeRename: async intent => {
        const names = [identity.canonical,identity.staging,identity.parking];
        if (!names.includes(intent.from) || !names.includes(intent.to)
          || ![identity.predecessorGeneration,identity.successorGeneration].includes(intent.generation)) {
          throw new Error("Native exchange recovery intent is outside its custody");
        }
        await transition.resume(intent);
      },
      observe: async () => ({canonical:await observe(identity.canonical),staging:await observe(identity.staging),parking:await observe(identity.parking)}),
      rename: async (from,to,generation,intent) => {
        const names=[identity.canonical,identity.staging,identity.parking];
        if (!ownsLifecycle() || !names.includes(from) || !names.includes(to) || from===to
          || ![identity.predecessorGeneration,identity.successorGeneration].includes(generation)) throw new Error("Native exchange rename is outside its custody");
        if (intent) {
          if (intent.from !== from || intent.to !== to || intent.generation !== generation) throw new Error("Native exchange rename intent differs from its command");
          await transition.resume(intent);
          return;
        }
        if ((await this.probeSession(to)).state !== "absent") throw new Error("Native exchange destination is not proven absent");
        await transition.resume(await transition.prepare(from,to,generation));
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

  private async createSessionUnchecked(name: string, cwd?: string, env?: Record<string, string>,
    launchOpts?: { processLimitsMode?: ProcessLimitsMode; failedStart?: SeatProcessLimitsProblem }): Promise<TmuxResult> {
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
    const notices: ScopeNotices = launchOpts?.failedStart ? { failedStart: launchOpts.failedStart } : {};
    let scopedCommand: string[] | null;
    try {
      scopedCommand = await this.scopedLaunchCommand(seatEnv, undefined, warnings, launchOpts?.processLimitsMode, notices,
        (file, recoveryEnv) => { bootstrap = file; Object.assign(seatEnv,recoveryEnv); });
    } catch (error) { if (error instanceof SeatProcessLimitsNotApplied) return processLimitsNotAppliedResult(error); throw error; }
    // These assignments enter our private transport, not literal psmux -e.
    // Identifier names use its versioned protocol; other representable Windows names
    // use private source-file persistence and are available to later recovery.
    const transportEnv = Object.entries(seatEnv).filter(([key]) =>
      !(this.isNativeWindows && scopedCommand) || isWindowsPrivateEnvironmentName(key));
    const formattedName = this.terminalKind === "psmux" ? name : tmuxSessionNameFormat(name);
    const argv = ["tmux", "new-session", "-d", "-s", formattedName];
    if (cwd != null) argv.push("-c", cwd);
    for (const [k, v] of transportEnv) argv.push("-e", `${k}=${v}`);
    const legacyParts = ["tmux", "new-session", "-d", "-s", tmuxConfigQuote(formattedName)];
    if (cwd != null) legacyParts.push("-c", tmuxConfigQuote(cwd));
    for (const [k, v] of transportEnv) legacyParts.push("-e", tmuxConfigQuote(`${k}=${v}`));
    // The pane new-session itself made: an after-new-session hook may select another window. A capped launch also
    // prints, from the same command, the session it made and its server (pid and start time), so a refusal below
    // removes that session and no other: a server that exits and comes back reuses pane and session ids.
    const printFormat = notices.capped ? CREATED_IDENTITY_FORMAT : "#{pane_id}";
    argv.push("-P", "-F", printFormat);
    legacyParts.push("-P", "-F", tmuxConfigQuote(printFormat));
    if (scopedCommand) { argv.push(...scopedCommand); legacyParts.push(...scopedCommand.map(tmuxConfigQuote)); }
    let printed: string;
    try {
      printed = (await this.runEnvironmentCommand(argv, legacyParts.join(" "), true, !!scopedCommand)).trim();
    } catch (err) {
      if (notices.marker) await this.fileOps.unlink(notices.marker).catch(() => {});
      await this.discardUnstartedScopedBootstrap(bootstrap, err, true);
      return classifyWriteError(err);
    }
    // A capped launch reads its pane and identity from the same, first, printed line (a hook may print more after it).
    const firstLine = notices.capped ? (printed.split("\n")[0] ?? "").trim() : printed;
    const made = notices.capped ? createdIdentity(firstLine) : null;
    const created = notices.capped ? (firstLine.split(" ")[0] ?? "") : printed;
    // tmux can exit 0 having made nothing: a server that can't create its socket prints its error and quits, and the
    // client still exits 0. new-session prints the pane it made; with none, the session must be read back before the
    // launch counts as created.
    if (!/^%\d+$/.test(created)) {
      const unconfirmed = await this.sessionUnconfirmedAfterCreate(name);
      // #3253: a capped launch whose session can't be read back may be running uncapped: the possibly-running refusal
      // (no retry, how to look and stop it). A session positively absent stays session_not_created.
      // Only a fresh launch: a recovery never stops for the limit, and keeps the plain session_unconfirmed.
      if (unconfirmed?.code === "session_unconfirmed" && notices.capped && launchOpts?.processLimitsMode !== "recovery") {
        if (notices.marker) await this.fileOps.unlink(notices.marker).catch(() => {});
        return processLimitsNotAppliedResult(new SeatProcessLimitsNotApplied({ kind: "unverified", commandStarted: "unknown",
          ...(notices.requested ? { requested: { ...notices.requested } } : {}),
          reason: `tmux printed no pane for the launch and its session couldn't be read back (${unconfirmed.message})` }),
          await this.removeRefusedSession(name, null));
      }
      if (unconfirmed) {
        // the scope start is never checked on this way out: its marker would be left pending in the temp dir
        if (notices.marker) await this.fileOps.unlink(notices.marker).catch(() => {});
        return { ok: false, ...unconfirmed };
      }
    }
    // #3253: a capped launch counts only once its scope is seen to start. A fresh one that isn't is refused and the
    // session it made is removed (never a retry without the limit). A recovery (a provider switch's staged successor)
    // never stops for the limit: when systemd-run fails after the check passed, the pane's command exits before
    // entering the scope, and the seat starts again without the limit, with the warning (in the same pane when tmux
    // kept it, else in a new session of the same name); when the start can't be told, nothing is run again.
    if (notices.capped) {
      const outcome = await this.scopeStartOutcome(/^%\d+$/.test(created) ? created : null, launchOpts?.processLimitsMode, notices, warnings);
      if (outcome && "refuse" in outcome) {
        return processLimitsNotAppliedResult(new SeatProcessLimitsNotApplied(outcome.refuse), await this.removeRefusedSession(name, made));
      }
      if (outcome) {
        const failedStart = outcome.retryUncapped;
        const kept = await this.probeSession(name).catch(() => ({ state: "unknown" as const }));
        return kept.state === "present"
          ? this.respawnPaneUnchecked(created, undefined, { ...(cwd != null ? { cwd } : {}), env: seatEnv,
            processLimitsMode: "recovery", failedStart })
          : this.createSessionUnchecked(name, cwd, env, { processLimitsMode: "recovery", failedStart });
      }
    }
    // A tmux server started from a Claude Code session or Herdr pane hands
    // their identity to every new pane. Mark it removed for this session only
    // and restart the fresh pane so its shell starts without it. The session
    // exists either way, so a failure here is a warning, never a failed launch.
    try {
      if (await this.excludeParentSessionEnv(exactTarget(name, "session"), Object.keys(seatEnv), name) && !scopedCommand) {
        if (!/^%\d+$/.test(created)) throw new Error(`new-session reported no pane id ("${created}"), so no pane was restarted`);
        const paneTarget = this.terminalKind === "psmux" ? `psmux:${Buffer.from(name).toString("base64url")}:${created}` : created;
        const respawn = ["tmux", "respawn-pane", "-k", "-t", paneTarget];
        if (cwd != null) respawn.push("-c", cwd);
        await this.run(respawn, posixJoinArgv(respawn));
      }
      return this.launched(warnings, notices);
    } catch (err) {
      return this.launched([...warnings, parentSessionEnvWarning(name, err)], notices);
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
  private async excludeParentSessionEnv(sessionTarget: string, keep: readonly string[] = [], sessionName?: string): Promise<boolean> {
    const inherited = await this.globalEnvironment();
    const compare = (key: string) => process.platform === "win32" ? key.toUpperCase() : key;
    const kept = new Set(keep.map(compare));
    const keys = parentSessionEnvKeys(inherited).filter((key) => !kept.has(compare(key)));
    for (const key of keys) {
      const argv = ["tmux", "set-environment", "-t", sessionTarget, "-r", key];
      if (sessionName !== undefined) await this.runNamedSession(argv, sessionName, posixJoinArgv(argv));
      else await this.run(argv, posixJoinArgv(argv));
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
          // This send's own checks can wait (a conversation lookup, an input capture), so they run first, and the
          // guard's checks run last (#3076). A check that refuses leaves a leftover's record for the next delivery.
          await options?.beforePaste?.();
          const checks = async () => { beforeWrite(); beforeInput?.(); };
          // The synchronous checks run again just before the key: the guard's re-read awaits after `checks`.
          const enter = async () => { beforeWrite(); beforeInput?.(); return (await this.sendKeysUnchecked(pane, ["Enter"])).ok; };
          if (checkDraft) await guard!.beforeInput(identity, false, text, { checks, enter });
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
      const windowsCodex = ["codex", "codex-code-mode-host"].includes(windowsCommand ?? "")
        || (windowsCommand !== null && await observeCodexPaneProcess({ target, tmux: this, requireArgv: true }) !== null);
      if (windowsCommand && bracketed && (windowsCodex || !["pwsh", "powershell"].includes(windowsCommand))) {
        const pid = await this.getPanePid(target);
        if (!pid) throw new Error("Windows pane process unavailable; no payload submitted");
        if (policy) await policy.beforePaste();
        beforeWrite();
        // ConPTY removes bracketed-paste delimiters on its pipe. Console input
        // records preserve the delimiters and raw LF for the receiving editor.
        const helper = pathJoin(import.meta.dirname, "../../assets/windows-console-input.ps1");
        const powershell = windowsPowerShell();
        try {
          await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
            "-TargetPid", String(pid), "-PayloadFile", path, "-Mode", windowsCodex ? "codex" : "bracketed"], { windowsHide: true, timeout: 15000 });
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
    if (path && paneShell === "fish" && !options.posix) {
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
        // The caller's checks can wait (a conversation lookup), so they run first and the guard's input read runs
        // last, as in sendText (#3076): input typed while they wait is seen, and a key is not sent onto it.
        if (options?.beforeKeys) await options.beforeKeys();
        if (this.deliveryGuard?.needsInputCheck(identity)) await this.deliveryGuard.beforeInput(identity, submit);
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
    // Escaped here, at the one place a key argument becomes a tmux argument, so both transports read
    // the same argv and neither can be the one that splits a key into two commands.
    const sent = keys.map(escapeTmuxCommandSeparator);
    try {
      if (this.terminalKind === "psmux" && process.platform === "win32" && keys.length === 1 && keys[0] === "C-u"
        && ["codex", "codex-code-mode-host"].includes((await this.getPaneCommand(target) ?? "").replace(/\.exe$/, "").toLowerCase())) {
        const pid = await this.getPanePid(target);
        if (!pid) return { ok: false, code: "guard_target_unknown", message: "Native console process unavailable; no key sent." };
        try {
          await execFileAsync(windowsPowerShell(),
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", pathJoin(import.meta.dirname, "../../assets/windows-console-input.ps1"), "-TargetPid", String(pid), "-Mode", "codex-clear"], { windowsHide: true, timeout: 15000 });
        } catch { return { ok: false, code: "native_key_unverified", message: "Native console key delivery unverified." }; }
        return { ok: true };
      }
      await this.run(["tmux", "send-keys", "-t", target, ...sent],
        `tmux send-keys -t ${shellQuote(target)} ${sent.map(shellQuote).join(" ")}`);
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

  /** #3253: removes the session a refused fresh launch made, by the identity its new-session printed, and only while
   *  that id is that session on that server. Null when it is gone (removed now, or already gone with its pane or its
   *  server); otherwise the sentence the refusal adds: the session may still be running, and how to look and stop it.
   *  Without a printed identity nothing is removed, never by name (a same-named session may not be this launch's). */
  private async removeRefusedSession(name: string, made: CreatedIdentity | null): Promise<string | null> {
    const look = ` Look with \`${tmuxOnDaemonServer()} attach -t ${shellQuote(`=${name}`)}\` and stop it with `
      + `\`${tmuxOnDaemonServer()} kill-session -t ${shellQuote(`=${name}`)}\` if it is this launch's.`;
    if (!made) return `Its session "${name}" may still be running: tmux didn't print the session it made, so it was not removed.${look}`;
    const removed = await this.killSessionUnchecked(made.session, undefined, undefined, made.server)
      .catch((err: unknown) => classifyWriteError(err));
    // Gone either way: removed now, no longer there (session_not_found), or its server was replaced (guard_target_changed:
    // the id names another terminal now, and the server that held this session is gone with it).
    if (removed.ok || removed.code === "session_not_found" || removed.code === "guard_target_changed") return null;
    // tmux's own words, without an exec wrapper's "Command failed: <command>" line.
    const said = removed.message.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("Command failed:")).join(" ")
      || removed.message.trim();
    return `Its session "${name}" (${made.session}) may still be running: it could not be removed (${said}).${look}`;
  }

  /** With a delivery guard, terminate by immutable tmux session ID; checked callers validate before detach and kill.
   *  A seat's session is stopped only when it carries that seat's OpenRig marker, and each effect runs only while that
   *  id still names a session on the server it was read from: a replaced server reuses ids for other terminals.
   *  A checked caller's validation may be asynchronous (a fresh process observation); it's awaited right before each
   *  effect, after this method's own reads, and the guard's synchronous check runs after it. */
  async killSession(name: string, beforeEffect?: () => void | Promise<void>): Promise<TmuxResult> {
    let stopPhase: StopPhase = "none";
    if (this.deliveryGuard) {
      const result = await this.guardedInput(name, async (pane, beforeWrite, nodeId) => {
        // The session id and its server (pid and start time) in one read, so the effects below can be held to both.
        const stdout = await this.run(["tmux", "display-message", "-p", "-t", pane, "#{session_id}|#{pid}|#{start_time}"],
          `tmux display-message -p -t ${shellQuote(pane)} '#{session_id}|#{pid}|#{start_time}'`);
        const [sessionId = "", pid = "", start = ""] = stdout.trim().split("|");
        if (!/^\$\d+$/.test(sessionId) || !/^\d+$/.test(pid) || !/^\d+$/.test(start)) {
          return { ok: false, code: "guard_target_unknown", message: "Cannot establish immutable session identity; no session killed." };
        }
        if (nodeId) {
          const unproven = await this.unprovenSeatSession(name, sessionId, nodeId);
          if (unproven) return unproven;
        }
        const kill = async () => {
          const scopedId = this.terminalKind === "psmux" && pane.startsWith("psmux:")
            ? `${pane.slice(0, pane.lastIndexOf(":") + 1)}${sessionId}` : sessionId;
          const result = await this.killSessionUnchecked(scopedId, beforeEffect && (async () => { await beforeEffect(); beforeWrite(); }), phase => { stopPhase = phase; }, { pid, start });
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

  /** The session a seat's stop would end is the seat's own: every session OpenRig creates for a seat carries its node's
   *  OPENRIG_NODE_ID. One without it (adopted, bound or discovered from outside), or with another seat's, is left
   *  running and named; nothing is detached or killed. */
  private async unprovenSeatSession(name: string, sessionId: string, nodeId: string): Promise<TmuxResult | null> {
    let marker: string | null = null;
    try {
      const out = (await this.run(["tmux", "show-environment", "-t", sessionId, "OPENRIG_NODE_ID"])).trim();
      if (out.startsWith("OPENRIG_NODE_ID=")) marker = out.slice("OPENRIG_NODE_ID=".length);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/unknown variable/i.test(message)) {
        return { ok: false, code: "guard_target_unknown", message: `'${name}' was left running: its OpenRig marker couldn't be read (${message.trim()}), so nothing was detached or killed.` };
      }
    }
    if (marker === nodeId) return null;
    const why = marker === null ? "doesn't carry this seat's OpenRig marker (OPENRIG_NODE_ID)" : `carries another seat's OpenRig marker (OPENRIG_NODE_ID=${marker})`;
    return { ok: false, code: "seat_target_unproven", message: `'${name}' was left running: its tmux session ${sessionId} ${why}, so it can't be shown `
      + "to be this seat's terminal, and nothing was detached or killed. A session OpenRig didn't create, such as an adopted one, has no marker. "
      // On the daemon's own tmux server: a person's plain `tmux` can reach another server, and a namesake there.
      + `If it is this seat's, look first with \`${tmuxOnDaemonServer()} attach -t ${shellQuote(`=${name}`)}\`, then stop it with `
      + `\`${tmuxOnDaemonServer()} kill-session -t ${shellQuote(`=${name}`)}\` and run the command again.` };
  }

  /** Keep effect checks outside command catches so a selection refusal retains its code and phase. */
  private async killSessionUnchecked(name: string, beforeEffect?: () => void | Promise<void>, phase?: (value: StopPhase) => void, server?: { pid: string; start: string }): Promise<TmuxResult> {
    if (this.terminalKind === "psmux") {
      let sessionName: string;
      let id: string;
      try {
        const scoped = /^psmux:([A-Za-z0-9_-]+):(\$\d+)$/.exec(name);
        sessionName = scoped ? Buffer.from(scoped[1]!, "base64url").toString("utf8") : name.replace(/^=/, "");
        id = scoped?.[2] ?? (await this.runNamedSession(["tmux", "display-message", "-p", "-t", `=${sessionName}:`, "#{session_id}"], sessionName, undefined, true)).trim();
        if (!/^\$\d+$/.test(id)) return { ok: false, code: "guard_target_unknown", message: "Native session identity unavailable; nothing killed." };
      } catch (error) { return classifyWriteError(error); }
      await beforeEffect?.();
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
    // With its server, an effect runs only while this id is that session on that server: tmux checks and acts in one
    // command, so a server replaced since the read (whose ids name other terminals) is left alone.
    const changed = "openrig-stop-target-changed";
    const effect = (verb: string, flag: string): string[] => server
      ? ["tmux", "if-shell", "-F", "-t", session,
        `#{&&:#{==:#{session_id},${session}},#{&&:#{==:#{pid},${server.pid}},#{==:#{start_time},${server.start}}}}`,
        `${verb} ${flag} '${session}'`, `display-message -p ${changed}`]
      : ["tmux", verb, flag, session];
    // Detach first so `detach-on-destroy off` cannot switch views onto another session.
    await beforeEffect?.();
    phase?.("detach_attempted");
    try {
      const out = await this.run(effect("detach-client", "-s"), server ? undefined : `tmux detach-client -s ${shellQuote(session)}`);
      if (out.includes(changed)) return { ok: false, code: "guard_target_changed", message: `${session} is no longer that session on the tmux server it was read from (the server may have been replaced); nothing was detached or killed.` };
    } catch (err) {
      // tmux 3.7 says "no current client" when nothing is attached (and for a missing session, which the kill classifies).
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toLowerCase().includes("no current client")) return classifyWriteError(err);
    }
    phase?.("detached");
    await beforeEffect?.();
    phase?.("kill_attempted");
    try {
      const out = await this.run(effect("kill-session", "-t"), server ? undefined : `tmux kill-session -t ${shellQuote(session)}`);
      if (out.includes(changed)) return { ok: false, code: "guard_target_changed", message: `${session} is no longer that session on the tmux server it was read from (the server may have been replaced); it was detached, but nothing was killed.` };
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
    opts?: { cwd?: string; env?: Record<string, string>; processLimitsMode?: ProcessLimitsMode;
      /** #3253: a bare respawn (no `env`) of this seat that keeps its limit in a new scope (seatProcessLimitsKeepPlan). */
      keepLimitOf?: string },
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

  private async respawnPaneUnchecked(paneTarget: string, command?: string,
    opts?: { cwd?: string; env?: Record<string, string>; processLimitsMode?: ProcessLimitsMode; keepLimitOf?: string;
      failedStart?: SeatProcessLimitsProblem }): Promise<TmuxResult> {
    const exact = exactTarget(paneTarget, "pane");
    const argv = ["tmux", "respawn-pane", "-t", exact];
    if (opts?.cwd != null) argv.push("-c", opts.cwd);
    const launchEnv = {...opts?.env};
    const warnings: string[] = [];
    let bootstrap: string | undefined;
    let scopedCommand: string[] | null;
    const notices: ScopeNotices = opts?.failedStart ? { failedStart: opts.failedStart } : {};
    try {
      scopedCommand = opts?.keepLimitOf && !opts.env
        ? await this.keptScopeCommand(opts.keepLimitOf, exact, command, warnings, notices, file => { bootstrap = file; })
        : await this.scopedLaunchCommand(launchEnv, command, warnings, opts?.processLimitsMode, notices, (file, recoveryEnv) => { bootstrap = file; Object.assign(launchEnv,recoveryEnv); });
    } catch (error) { if (error instanceof SeatProcessLimitsNotApplied) return processLimitsNotAppliedResult(error); throw error; }
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
      // #3253: a capped respawn counts only once its scope is seen to start. A fresh one that isn't is refused (the pane
      // is not this launch's to remove). A recovery never stops for the limit, also when systemd-run fails at this
      // moment (after the check passed): its pane's command exits before the seat's command starts in the scope, and
      // the recovery starts it again without the limit, with the warning; when the start can't be told, it runs
      // nothing again.
      if (notices.capped) {
        const outcome = await this.scopeStartOutcome(exact, opts?.keepLimitOf ? "recovery" : opts?.processLimitsMode, notices, warnings);
        if (outcome && "refuse" in outcome) return processLimitsNotAppliedResult(new SeatProcessLimitsNotApplied(outcome.refuse));
        if (outcome) return this.respawnPaneUnchecked(paneTarget, command, { ...opts, failedStart: outcome.retryUncapped });
      }
      return this.launched(warnings, notices);
    } catch (err) {
      if (notices.marker) await this.fileOps.unlink(notices.marker).catch(() => {});
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

  /** Leave every mode the pane is in, through the same input guard as sendKeys. Modes stack: copy mode can sit under
   *  run-shell output (view-mode), a chooser, customize or clock mode, and `send-keys -X cancel` leaves only a copy or
   *  view mode on top. `copy-mode -q` (tmux 3.1a+) leaves them all and types nothing; older tmux falls back to -X cancel. */
  async cancelPaneMode(target: string): Promise<TmuxResult> {
    return this.guardedInput(target, async (pane, beforeWrite) => {
      beforeWrite();
      try {
        await this.run(["tmux", "copy-mode", "-q", "-t", pane]);
        return { ok: true };
      } catch (error) {
        // The fallback is a second write: check the guard again, as the read-only Enter fallback does, so input that
        // arrived while copy-mode -q was pending stops it.
        beforeWrite();
        const fallback = await this.sendKeysUnchecked(pane, ["-X", "cancel"]);
        if (fallback.ok) return fallback;
        // Both failed: keep both reasons, so the refusal that reports this can name them.
        return { ...fallback, message: `copy-mode -q: ${error instanceof Error ? error.message : String(error)}; send-keys -X cancel: ${fallback.message}` };
      }
    }, false, "keys");
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

  /** Remove one variable from a session's environment. Ordinary names inherit the server's value
   *  afterwards, if any. Credentials and the launching session's own identity are marked removed
   *  instead, so they cannot come back from the server's global environment. */
  async unsetSessionEnv(session: string, key: string): Promise<void> {
    if (!(this.terminalKind === "psmux" ? isWindowsPrivateEnvironmentName(key) : /^[A-Z_][A-Z0-9_]*$/.test(key))) throw new Error("Invalid session environment key.");
    const target = exactTarget(session, "session");
    const parents = parentSessionEnvKeys(await this.globalEnvironment()).filter(name => process.platform === "win32" ? name.toUpperCase() === key.toUpperCase() : name === key);
    const flag = isTmuxCredentialEnvKey(key) || parents.length ? "-r" : "-u";
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

  /** Compare transient native values with the kept session. Only differing names escape this read. */
  async differingSessionEnv(sessionName: string, running: Readonly<Record<string, string>>): Promise<string[] | null> {
    const lines = await this.sessionEnvLines(sessionName);
    if (lines === null) return null;
    const inherited = new Set(lines);
    return Object.entries(running).filter(([key, value]) => key !== "CLAUDE_CONFIG_DIR" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      && !inherited.has(`${key}=${value}`)).map(([key]) => key).sort();
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
      // The marker line also names the pane and its process that the capture after it reads, in the same call.
      const header = (k: number) => `${mark(k)} #{pane_id} #{pane_pid}`;
      const argv = ["tmux", ...chunk.flatMap((t, k) => [
        ...(k > 0 ? [";"] : []),
        "display-message", "-p", "-t", `=${physical[k]}:`, header(k), ";", "capture-pane", "-p", "-t", `=${physical[k]}:`, "-S", `-${lines}`,
      ])];
      const legacy = "tmux " + chunk.map((t, k) =>
        `display-message -p -t ${shellQuote(`=${t}:`)} ${shellQuote(header(k))} \\; capture-pane -p -t ${shellQuote(`=${t}:`)} -S -${lines}`,
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
      const panes: Array<PaneCapture["pane"]> = chunk.map(() => undefined);
      const marker = new RegExp(`^__openrig_capture_${nonce}_(\\d+)__(?: (.*))?$`);
      let cur = -1;
      const outLines = output.split("\n");
      if (outLines.length && outLines[outLines.length - 1] === "") outLines.pop(); // the final newline, not a line
      for (const line of outLines) {
        const m = line.startsWith(`__openrig_capture_${nonce}_`) ? marker.exec(line) : null;
        if (m && Number(m[1]) < chunk.length) {
          cur = Number(m[1]);
          segments[cur] = [];
          const identity = /^(%\d+) (\d+)$/.exec(m[2] ?? "");
          panes[cur] = identity ? {
            id: this.terminalKind === "psmux" ? `psmux:${Buffer.from(chunk[cur]!).toString("base64url")}:${identity[1]}` : identity[1]!,
            pid: Number(identity[2]),
          } : undefined;
        } else if (cur >= 0) {
          segments[cur]!.push(line);
        }
      }
      chunk.forEach((t, k) => {
        const seg = segments[k];
        if (seg == null) return; // its marker never printed: read per target
        // capture-pane prints its lines newline-terminated, as the per-target read returns them
        const text = seg.length ? seg.join("\n") + "\n" : "";
        out.set(t, { text: text === "" ? null : text, capturedAt, ...(panes[k] ? { pane: panes[k] } : {}) });
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

  /** The clients attached to a session: each one's terminal device and the terminal type it reported (XTVERSION,
   *  "" when it reported none). Empty when the session has no clients, or when the session or the server is gone;
   *  null when tmux can't be read. */
  async listSessionClientTerminals(session: string): Promise<Array<{ tty: string; termtype: string }> | null> {
    const exact = exactTarget(session, "session");
    const format = `#{client_tty}${TMUX_FIELD_SEPARATOR}#{client_termtype}`;
    try {
      const output = await this.run(["tmux", "list-clients", "-t", exact, "-F", format],
        `tmux list-clients -t ${shellQuote(exact)} -F "${format}"`);
      return output.split("\n").flatMap((line) => {
        const separator = line.indexOf(TMUX_FIELD_SEPARATOR);
        const tty = line.slice(0, Math.max(separator, 0));
        return tty.startsWith("/dev/") ? [{ tty, termtype: line.slice(separator + TMUX_FIELD_SEPARATOR.length) }] : [];
      });
    } catch (err) {
      return isServerMissingError(err) || isSessionAbsenceError(tmuxReportedError(err)) ? [] : null;
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

  /** Retarget an existing view with session identity separate from window syntax. */
  async switchClientToSession(client: string, name: string, windowIndex?: number): Promise<TmuxResult> {
    if (windowIndex !== undefined && (!Number.isSafeInteger(windowIndex) || windowIndex < 0)) return { ok: false, code: "invalid_window", message: "Invalid window index" };
    const target = `=${name}${windowIndex === undefined ? "" : ":" + windowIndex}`;
    try {
      const argv = this.terminalKind === "psmux" ? ["tmux", "switch-client", "-t", target, "-c", client]
        : ["tmux", "switch-client", "-c", client, "-t", target];
      await this.runNamedSession(argv, name, `tmux switch-client -c ${shellQuote(client)} -t ${shellQuote(target)}`, windowIndex !== undefined, windowIndex);
      return { ok: true };
    } catch (error) { return classifyWriteError(error); }
  }
}
