import { DeliveryGuardError, type SeatDeliveryGuard } from "../domain/seat-delivery-guard.js";
import { writeFile as fsWriteFile, unlink as fsUnlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { randomUUID } from "node:crypto";

export type ExecFn = (cmd: string) => Promise<string>;

interface TmuxShellCommandOptions {
  /** Pi can send commands within the terminal byte bound directly. */
  stageIfLong?: boolean;
  /** A staged single-executable runner must replace the staging shell. */
  execInScript?: boolean;
}

/**
 * Argv exec: run the multiplexer WITHOUT a shell (execFile-style — the
 * binary is argv[0], the rest are verbatim arguments, no quoting layer).
 * This is the Windows/psmux path: POSIX shells, single-quote quoting and
 * `/dev/null` redirections do not exist there. Opt-in via the constructor;
 * when absent every method uses the legacy shell-string path unchanged.
 */
export type ArgvExecFn = (argv: string[]) => Promise<string>;

/**
 * Injectable file/buffer operations for `sendText`.
 * Split out so tests can observe temp-file writes and unique-name generation
 * without touching the real filesystem; production wires node fs + os.tmpdir.
 */
export interface TmuxFileOps {
  writeFile(path: string, content: string, options?: { mode: number; flag: "wx" }): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Unique temp-file path per call - parallel `rig up` stands up many seats. */
  tmpName(): string;
  /** Unique tmux buffer name per call - a fixed name would collide under concurrency. */
  bufferName(): string;
}

function defaultTmuxFileOps(): TmuxFileOps {
  return {
    writeFile: (p, content, options) => fsWriteFile(p, content, { encoding: "utf8", ...options }),
    unlink: (p) => fsUnlink(p),
    tmpName: () => pathJoin(tmpdir(), `openrig-tmux-send-${process.pid}-${randomUUID()}.txt`),
    bufferName: () => `openrig_${process.pid}_${randomUUID().replace(/-/g, "")}`,
  };
}

export type TmuxResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

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
  return err instanceof Error && err.message.includes("no server running");
}

function isSessionAbsenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("session not found") ||
    msg.includes("can't find session") ||
    msg.includes("no current target") ||
    msg.includes("no session");
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

/** Shell-quote a string using single quotes (POSIX-safe). */
/** One pane's text from a batched capture, with the time its chunk was read (#309 review). `text` is null for a
 *  session that is gone or an empty capture. */
export interface PaneCapture { text: string | null; capturedAt: Date }

/** The most sessions one batched capture chains (#308). Not a byte bound: a chunk whose output overflows exec's buffer
 *  fails and is split in half. */
const CAPTURE_BATCH = 24;

function shellQuote(s: string): string {
  // Replace each ' with '"'"' (end quote, double-quote the apostrophe, resume quote)
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
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
  const windows = parseInt(parts[1]!, 10);
  if (isNaN(windows)) return null;
  return {
    name: parts[0]!,
    windows,
    created: parts[2]!,
    attached: parts[3] === "1",
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
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parser)
    .filter((result): result is T => result !== null);
}

export class TmuxAdapter {
  deliveryGuard?: SeatDeliveryGuard;
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
      const out = await this.exec(`tmux new-session -d -P -F ${shellQuote("#{session_id} #{session_created}")} -s ${shellQuote(name)}${cwd != null ? ` -c ${shellQuote(cwd)}` : ""}`);
      const match = /^(\$\d+) (\d+)$/.exec(out.trim());
      created = match ? { id: match[1]!, at: match[2]! } : null;
    } catch (err) {
      return classifyWriteError(err);
    }
    let message = "New probe pane could not be established; no input written.";
    let pane: string | null = null;
    try {
      const panes = await this.listPanes(name);
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
    const same = `#{&&:#{==:#{session_name},${name}},#{==:#{session_created},${created.at}}}`;
    try {
      const out = await this.exec(`tmux if-shell -F -t ${shellQuote(created.id)} ${shellQuote(same)} ${shellQuote(`kill-session -t '${created.id}'`)} ${shellQuote("display-message -p kept")}`);
      if (out.includes("kept")) return { ok: false, code: "guard_target_changed", message: `its id ${created.id} no longer names it (it may already be gone); nothing was killed.` };
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  private async guardedInput(target: string, write: (pane: string, beforeWrite: () => void) => Promise<TmuxResult>, allowAbsent = false): Promise<TmuxResult> {
    const guard = this.deliveryGuard;
    if (!guard) return write(target, () => {});
    try {
      const probePane = this.freshProbes.get(target);
      if (probePane && !guard.maybeTarget(target)) {
        const panes = await this.listPanes(target);
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
        try { panes = await this.listPanes(fresh ? target : bound.session); }
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
        if (!pane || panes.length !== 1 || panes[0]!.id !== pane) throw new Error("Managed pane identity unavailable or changed; no input written.");
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
  ) {}

  /**
   * Run a multiplexer command. `argv` is what is EXECUTED on both paths:
   * elements are verbatim (no quoting layer) when argvExec is wired;
   * otherwise they are POSIX-joined — byte-identical to the legacy
   * template strings for all current call sites (the suite pins them).
   * `legacy` overrides the joined form only where history quoted
   * differently (the `-F "..."` double-quoted formats); pass it ONLY to
   * preserve an exact legacy string, never to smuggle new semantics.
   */
  private async run(argv: string[], legacy?: string): Promise<string> {
    if (this.argvExec) return this.argvExec(argv);
    return this.exec(legacy ?? posixJoinArgv(argv));
  }

  /** Start an empty native terminal server, without inventing a seat/session. */
  async startServer(): Promise<TmuxResult> {
    const probeName = `openrig-startup-${randomUUID()}`;
    try {
      if ((await this.probeSession(probeName)).state !== "transport_unavailable") return { ok: true };
      // tmux -D keeps an empty server alive. Stays on the shell-string path
      // deliberately: detach + stdio redirection have no argv equivalent,
      // and server bootstrap is POSIX-specific (psmux auto-starts its own).
      // Native socket ownership arbitrates
      // concurrent starts; the readback below, not shell exit, proves availability.
      await this.exec("tmux -D </dev/null >/dev/null 2>&1 &");
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
      return parseLines(output, parseSessionLine);
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

  async listPanes(target: string): Promise<TmuxPane[]> {
    // Callers name a session (optionally with a window), or an immutable tmux
    // id. Exact session matching prevents observing a prefix neighbor's pane.
    // A bare leading '=' belongs to the literal session name. Only qualified
    // targets already carry tmux's encoded exact-match syntax.
    const namedTarget = target.includes(":") && target.startsWith("=") ? target : `=${target}`;
    const exactTarget = /^[%$@]\d+$/.test(target) ? target
      : namedTarget.includes(":") ? namedTarget : `${namedTarget}:`;
    try {
      const output = await this.run(["tmux", "list-panes", "-t", exactTarget, "-F", PANE_FORMAT],
        `tmux list-panes -t ${shellQuote(exactTarget)} -F "${PANE_FORMAT}"`);
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
      await this.run(["tmux", "has-session", "-t", target],
        `tmux has-session -t ${shellQuote(target)}`);
      return { state: "present" }; // exit 0 = session exists
    } catch (err) {
      if (isSessionAbsenceError(err)) {
        return { state: "absent" };
      }
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) {
        return { state: "transport_unavailable", cause: (err as Error).message };
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

  async createSession(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    if (this.deliveryGuard && (!env?.OPENRIG_NODE_ID || !this.deliveryGuard.ownsLifecycle(env.OPENRIG_NODE_ID))) {
      return { ok: false, code: "guard_lease_required", message: "Managed launch requires a lifecycle lease before terminal creation." };
    }
    const result = await this.createSessionUnchecked(name, cwd, env);
    if (result.ok && this.deliveryGuard && env?.OPENRIG_NODE_ID) {
      try {
        const panes = await this.listPanes(name);
        if (panes.length === 1) this.freshManaged.set(name, {nodeId: env.OPENRIG_NODE_ID, pane: panes[0]!.id});
      } catch { /* no fresh pane proof: subsequent writes remain refused */ }
    }
    return result;
  }

  /** The committed binding now owns identity; this is not filesystem cleanup. */
  finishLaunchBinding(session: string): void { this.freshManaged.delete(session); }

  private async createSessionUnchecked(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    // These are the daemon's resolved capture settings, not seat overrides.
    // An empty per-session value prevents the tmux server's inherited values
    // from pinning an old policy over config.json inside a newly launched seat.
    // Explicit seat settings remain authoritative.
    const seatEnv = {
      OPENRIG_TRANSCRIPTS_LINES: "",
      OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "",
      ...env,
    };
    const argv = ["tmux", "new-session", "-d", "-s", name];
    if (cwd != null) argv.push("-c", cwd);
    for (const [k, v] of Object.entries(seatEnv)) argv.push("-e", `${k}=${v}`);
    const legacyParts = ["tmux", "new-session", "-d", "-s", shellQuote(name)];
    if (cwd != null) legacyParts.push("-c", shellQuote(cwd));
    for (const [k, v] of Object.entries(seatEnv)) legacyParts.push("-e", shellQuote(`${k}=${v}`));
    try {
      await this.run(argv, legacyParts.join(" "));
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * Paste text at every size. Unbracketed input can be consumed as individual
   * keystrokes by agent TUIs, losing text even below the old 8 KiB cutoff.
   * A file keeps payload bytes out of shell/tmux argv and its size limits.
   *   `-p`  bracket the paste when the receiving application enables that mode.
   *   `-r`  preserve raw LF. tmux's default paste-buffer replaces every LF with
   *         CR, and CR is SUBMIT in the Claude/Codex TUIs - a
   *         default paste of a multi-line pack would submit on every newline.
   *   `-d`  drop the buffer after a successful paste.
   * The single trailing submit stays the caller's separate `sendKeys(["Enter"])`.
   * Cleanup unlinks the temp file in `finally`; if the buffer was loaded but the
   * paste failed (e.g. missing target), an explicit `delete-buffer` runs so no
   * buffer leaks. Unique temp + buffer names per call keep parallel `rig up`
   * seats from colliding.
   */
  async sendText(target: string, text: string, beforeInput?: () => void): Promise<TmuxResult> {
    return this.guardedInput(target, (pane, beforeWrite) => this.sendTextUnchecked(pane, text, () => { beforeWrite(); beforeInput?.(); }));
  }

  private async sendTextUnchecked(target: string, text: string, beforeWrite: () => void): Promise<TmuxResult> {
    const path = this.fileOps.tmpName();
    const buffer = this.fileOps.bufferName();
    let bufferLoaded = false;
    let created = false;
    try {
      await this.fileOps.writeFile(path, text, { mode: 0o600, flag: "wx" });
      created = true;
      await this.run(["tmux", "load-buffer", "-b", buffer, path],
        `tmux load-buffer -b ${shellQuote(buffer)} ${shellQuote(path)}`);
      bufferLoaded = true;
      beforeWrite();
      await this.run(["tmux", "paste-buffer", "-t", target, "-b", buffer, "-d", "-r", "-p"],
        `tmux paste-buffer -t ${shellQuote(target)} -b ${shellQuote(buffer)} -d -r -p`);
      return { ok: true };
    } catch (err) {
      if (bufferLoaded) {
        // paste failed after load - `-d` never ran, so the buffer is still
        // resident. Best-effort delete to avoid leaking it.
        try {
          await this.run(["tmux", "delete-buffer", "-b", buffer],
        `tmux delete-buffer -b ${shellQuote(buffer)}`);
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
    return this.guardedInput(target, () => this.sendShellCommandUnchecked(target, command, beforeInput, options));
  }

  private async sendShellCommandUnchecked(target: string, command: string, beforeInput: (() => void) | undefined, options: TmuxShellCommandOptions): Promise<TmuxResult> {
    const commandBytes = Buffer.byteLength(command, "utf8");
    let path = options.stageIfLong && commandBytes <= 512 ? undefined : this.fileOps.tmpName();
    let invocation = path ? `/bin/sh ${shellQuote(path)}` : command;
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
        await this.fileOps.writeFile(path, `/bin/rm -f -- ${shellQuote(path)}\n${options.execInScript ? "exec " : ""}${command}\n`, { mode: 0o600, flag: "wx" });
        created = true;
      }
      const text = beforeInput ? await this.guardedInput(target, (pane, check) => this.sendTextUnchecked(pane, invocation, () => { check(); beforeInput(); }))
        : await this.sendText(target, invocation);
      if (!text.ok) return text;
      const enter = beforeInput ? await this.guardedInput(target, pane => { beforeInput(); return this.sendKeysUnchecked(pane, ["Enter"]); })
        : await this.sendKeys(target, ["Enter"]);
      if (!enter.ok) {
        await this.sendKeys(target, ["C-c"]);
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

  async sendKeys(target: string, keys: string[], beforeInput?: () => void): Promise<TmuxResult> {
    return this.guardedInput(target, (pane, beforeWrite) => { beforeWrite(); beforeInput?.(); return this.sendKeysUnchecked(pane, keys); });
  }

  private async sendKeysUnchecked(target: string, keys: string[]): Promise<TmuxResult> {
    try {
      await this.run(["tmux", "send-keys", "-t", target, ...keys],
        `tmux send-keys -t ${shellQuote(target)} ${keys.map(shellQuote).join(" ")}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async setWindowOption(target: string, option: string, value: string): Promise<TmuxResult> {
    try {
      await this.run(["tmux", "set-option", "-w", "-t", target, option, value],
        `tmux set-option -w -t ${shellQuote(target)} ${shellQuote(option)} ${shellQuote(value)}`);
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
      await this.run(["tmux", "resize-window", "-t", target, "-x", String(cols), "-y", String(rows)]);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async killSession(name: string): Promise<TmuxResult> {
    if (this.deliveryGuard) {
      return this.guardedInput(name, async pane => {
        const stdout = await this.run(["tmux", "display-message", "-p", "-t", pane, "#{session_id}"], `tmux display-message -p -t ${shellQuote(pane)} '#{session_id}'`);
        const sessionId = stdout.trim();
        if (!/^\$\d+$/.test(sessionId)) return { ok: false, code: "guard_target_unknown", message: "Cannot establish immutable session identity; no session killed." };
        const kill = async () => {
          const result = await this.killSessionUnchecked(sessionId);
          if (result.ok) { this.freshProbes.delete(name); this.freshProbes.delete(pane); this.freshManaged.delete(name); }
          return result;
        };
        if (this.freshProbes.get(name) === pane && !this.deliveryGuard!.maybeTarget(name) && !this.deliveryGuard!.maybeTarget(pane)) return kill();
        return this.deliveryGuard!.input(this.freshManaged.get(name)?.nodeId ?? name, kill);
      }, true);
    }
    return this.killSessionUnchecked(name);
  }

  private async killSessionUnchecked(name: string): Promise<TmuxResult> {
    // Detach first so `detach-on-destroy off` cannot switch views onto another session.
    try {
      await this.run(["tmux", "detach-client", "-s", name],
        `tmux detach-client -s ${shellQuote(name)}`);
    } catch (err) {
      // tmux 3.7 says "no current client" when nothing is attached (and for a missing session, which the kill classifies).
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toLowerCase().includes("no current client")) return classifyWriteError(err);
    }
    try {
      await this.run(["tmux", "kill-session", "-t", name],
        `tmux kill-session -t ${shellQuote(name)}`);
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
    return this.guardedInput(paneTarget, pane => this.respawnPaneUnchecked(pane, command, opts));
  }

  private async respawnPaneUnchecked(paneTarget: string, command?: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<TmuxResult> {
    const argv = ["tmux", "respawn-pane", "-t", paneTarget];
    if (opts?.cwd != null) argv.push("-c", opts.cwd);
    if (opts?.env) for (const [k, v] of Object.entries(opts.env)) argv.push("-e", `${k}=${v}`);
    // The respawn command is ONE argv unit: tmux runs it via the shell.
    if (command != null && command.length > 0) argv.push(command);
    const legacyRespawn = ["tmux", "respawn-pane", "-t", shellQuote(paneTarget)];
    if (opts?.cwd != null) legacyRespawn.push("-c", shellQuote(opts.cwd));
    if (opts?.env) for (const [k, v] of Object.entries(opts.env)) legacyRespawn.push("-e", shellQuote(`${k}=${v}`));
    if (command != null && command.length > 0) legacyRespawn.push(shellQuote(command));
    try {
      await this.run(argv, legacyRespawn.join(" "));
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Seat-handover cutover: set the pane-scoped `remain-on-exit` so the pane SURVIVES (goes dead, not
   *  destroyed) when the retiree process exits — holding its scrollback for the successor's respawn.
   *  Set to `on` BEFORE the retiree is signalled to exit (else the pane is destroyed on exit and there
   *  is nothing to respawn into). */
  async setRemainOnExit(paneTarget: string, on: boolean): Promise<TmuxResult> {
    try {
      await this.run(["tmux", "set-option", "-p", "-t", paneTarget, "remain-on-exit", on ? "on" : "off"],
        `tmux set-option -p -t ${shellQuote(paneTarget)} remain-on-exit ${on ? "on" : "off"}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Seat-handover cutover: is the pane's process dead (the retiree exited; the pane held by
   *  remain-on-exit)? A known-missing pane also proves physical cutover; unknown probe errors stay false. */
  async isPaneDead(paneId: string): Promise<boolean> {
    try {
      const output = await this.run(["tmux", "display-message", "-p", "-t", paneId, "#{pane_dead}"],
        `tmux display-message -p -t ${shellQuote(paneId)} "#{pane_dead}"`);
      return output.trim() === "1";
    } catch (error) {
      return isNoServerError(error) || isPaneAbsenceError(error);
    }
  }

  /** Seat-handover cutover: signal the pane's foreground process (the retiree) — `TERM` for the graceful
   *  exit-in-place, `KILL` for the bounded-timeout force fallback. Resolves the pane pid then `kill`s it;
   *  an unresolvable pid is a structured, non-throwing failure.
   *  Stays on the shell-string path deliberately: this is a Unix `kill`,
   *  not a multiplexer command (Windows needs taskkill — named follow-up). */
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
      await this.exec(`kill -${signal} ${pid}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Get the PID of the foreground process in a pane. Returns null if unavailable. */
  async getPanePid(paneId: string): Promise<number | null> {
    try {
      const output = await this.run(["tmux", "display-message", "-p", "-t", paneId, "#{pane_pid}"],
        `tmux display-message -p -t ${shellQuote(paneId)} "#{pane_pid}"`);
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
  async getPaneCommand(paneId: string): Promise<string | null> {
    try {
      const output = await this.run(["tmux", "display-message", "-p", "-t", paneId, "#{pane_current_command}"],
        `tmux display-message -p -t ${shellQuote(paneId)} "#{pane_current_command}"`);
      const trimmed = output.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /** A launch metadata read. Callers must never put credential values in terminal input. */
  async getSessionEnv(session: string, key: string): Promise<string | undefined> {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("Invalid session environment key.");
    try {
      const output = await this.run(["tmux", "show-environment", "-t", session, key],
        `tmux show-environment -t ${shellQuote(session)} ${shellQuote(key)}`);
      if (output.trim() === `-${key}`) return undefined;
      if (!output.startsWith(`${key}=`)) throw new Error("Unexpected session environment response.");
      return output.slice(key.length + 1).replace(/\r?\n$/, "");
    } catch (error) {
      if (error instanceof Error && error.message.includes(`unknown variable: ${key}`)) return undefined;
      throw new Error("Cannot read the session's launch environment.");
    }
  }

  /** OPR.0.4.3.28 Part C — usable-presence check for a session-env variable.
   *  Returns whether the var has a nonblank value, NEVER that value, and null
   *  when the session environment cannot be inspected. Listing the environment
   *  distinguishes a genuinely absent var from `tmux show-environment <var>`'s
   *  nonzero lookup exit. */
  async hasSessionEnv(sessionName: string, varName: string): Promise<boolean | null> {
    try {
      const output = await this.run(["tmux", "show-environment", "-t", sessionName],
        `tmux show-environment -t ${shellQuote(sessionName)}`);
      const prefix = `${varName}=`;
      return output.split(/\r?\n/).some(
        (line) => line.startsWith(prefix) && line.slice(prefix.length).trim().length > 0,
      );
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
    try {
      await this.run(["tmux", "pipe-pane", "-t", sessionName, sink],
        `tmux pipe-pane -t ${shellQuote(sessionName)} ${shellQuote(sink)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Stop pipe-pane on a session. */
  async stopPipePane(sessionName: string): Promise<TmuxResult> {
    try {
      await this.run(["tmux", "pipe-pane", "-t", sessionName],
        `tmux pipe-pane -t ${shellQuote(sessionName)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Capture pane content (last N lines). Returns null if unavailable. */
  /**
   * Capture many sessions' panes with a few tmux calls instead of one per session (#308). One `list-sessions` says
   * which targets exist: a missing one maps to null (as a failed per-target capture) without a fork. The live ones
   * are captured in chunks of CAPTURE_BATCH chained commands (a `display-message` marker, then `capture-pane`), each
   * pane's output delimited by a marker unique to the call, so the text equals what `capturePaneContent` returns.
   * Targets are exact (`=<name>:`): no prefix match, and a name with a "." still resolves. tmux stops a chain at its
   * first failing command, so a chunk that fails is split in half and retried (an oversized output, or a session gone
   * since the listing); a single session that still fails is left OUT of the map, and the caller reads it per target.
   * Null when tmux can't be listed at all. Each entry carries the time its own chunk was read (`capturedAt`), so a
   * slow later chunk can't make an earlier capture look fresh.
   */
  async capturePanesContent(targets: string[], lines: number = 20, now: () => Date = () => new Date()): Promise<Map<string, PaneCapture> | null> {
    let live: Set<string>;
    try {
      const listing = await this.run(["tmux", "list-sessions", "-F", "#{session_name}"], "tmux list-sessions -F '#{session_name}'");
      live = new Set(listing.split("\n").map((s) => s.trim()).filter(Boolean));
    } catch {
      return null;
    }
    const out = new Map<string, PaneCapture>();
    const listedAt = now();
    const present: string[] = [];
    for (const t of new Set(targets)) {
      if (live.has(t)) present.push(t);
      else out.set(t, { text: null, capturedAt: listedAt });
    }
    // A chunk that fails is split in half and retried, down to one session: its output overflowed exec's buffer (wide,
    // colour-dense panes: each capture is the visible pane plus the requested history) or a session vanished since
    // the listing. A single session that still fails is left out: the caller reads it per target.
    /** Capture one chunk with a single chained tmux call into `out`; on failure, split it in half and retry each half. */
    const captureChunk = async (chunk: string[]): Promise<void> => {
      const nonce = randomUUID().replace(/-/g, "");
      const mark = (k: number) => `__openrig_capture_${nonce}_${k}__`;
      const argv = ["tmux", ...chunk.flatMap((t, k) => [
        ...(k > 0 ? [";"] : []),
        "display-message", "-p", "-t", `=${t}:`, mark(k), ";", "capture-pane", "-p", "-t", `=${t}:`, "-S", `-${lines}`,
      ])];
      const legacy = "tmux " + chunk.map((t, k) =>
        `display-message -p -t ${shellQuote(`=${t}:`)} ${shellQuote(mark(k))} \\; capture-pane -p -t ${shellQuote(`=${t}:`)} -S -${lines}`,
      ).join(" \\; ");
      let output: string;
      let capturedAt: Date;
      try {
        output = await this.run(argv, legacy);
        capturedAt = now(); // when THIS chunk's panes were read, not when the sweep ends
      } catch {
        if (chunk.length > 1) {
          const half = Math.ceil(chunk.length / 2);
          await captureChunk(chunk.slice(0, half));
          await captureChunk(chunk.slice(half));
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
    for (let i = 0; i < present.length; i += CAPTURE_BATCH) await captureChunk(present.slice(i, i + CAPTURE_BATCH));
    return out;
  }

  async capturePaneContent(paneId: string, lines: number = 20): Promise<string | null> {
    try {
      const output = await this.run(["tmux", "capture-pane", "-p", "-t", paneId, "-S", `-${lines}`],
        `tmux capture-pane -p -t ${shellQuote(paneId)} -S -${lines}`);
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
  async capturePaneScreen(paneId: string): Promise<string | null> {
    try {
      const output = await this.run(["tmux", "capture-pane", "-p", "-t", paneId],
        `tmux capture-pane -p -t ${shellQuote(paneId)}`);
      return output || null;
    } catch {
      return null;
    }
  }

  /**
   * Get the current cursor coordinates and pane geometry. Coordinates are
   * zero-based. Returns null if unavailable or if tmux yields non-finite /
   * out-of-range values (x<0, y<0, width<1, height<1) so a bad read never
   * produces a garbage seed.
   */
  async getPaneCursorPosition(paneId: string): Promise<TmuxCursorPosition | null> {
    try {
      const output = await this.run(
        ["tmux", "display-message", "-p", "-t", paneId, CURSOR_FORMAT],
        `tmux display-message -p -t ${shellQuote(paneId)} "${CURSOR_FORMAT}"`,
      );
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
    try {
      await this.run(["tmux", "set-option", "-t", sessionName, key, value],
        `tmux set-option -t ${shellQuote(sessionName)} ${shellQuote(key)} ${shellQuote(value)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * OPR.0.4.6.02 S1 (guard b2): set a SERVER-scoped option via
   * `set-option -s <option> <value>` — the daemon configuring its OWN tmux
   * server (NOT a live-flip of anyone's session). NEVER targets a session
   * (`-t`): server scope and session scope are distinct and never crossed.
   * Used for `set-clipboard` / `copy-command`.
   */
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
    try {
      const output = await this.run(["tmux", "show-option", "-v", "-t", sessionName, key],
        `tmux show-option -v -t ${shellQuote(sessionName)} ${shellQuote(key)}`);
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
  /** Every session's current-window `#{window_activity}` in ONE tmux call, keyed by session name: the same value
   *  `readPaneLastActivity(<session name>)` reads (display-message -t <session> resolves to the session's current
   *  window). Only well-formed timestamps are included, so a missing key means "read it the per-target way". Null when
   *  tmux can't be read at all. The session name is the LAST field, so a separator inside it stays intact. */
  async readAllSessionWindowActivity(): Promise<Map<string, number> | null> {
    try {
      const format = ["#{window_active}", "#{window_activity}", "#{session_name}"].join(TMUX_FIELD_SEPARATOR);
      const output = await this.run(["tmux", "list-windows", "-a", "-F", format], `tmux list-windows -a -F '${format}'`);
      const out = new Map<string, number>();
      for (const line of output.split("\n")) {
        const first = line.indexOf(TMUX_FIELD_SEPARATOR), second = line.indexOf(TMUX_FIELD_SEPARATOR, first + 1);
        if (first < 0 || second < 0) continue;
        const active = line.slice(0, first), activity = line.slice(first + 1, second).trim(), session = line.slice(second + 1);
        if (!session || active !== "1" || !/^\d+$/.test(activity)) continue;
        const n = Number(activity);
        if (Number.isFinite(n) && n > 0) out.set(session, n);
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Every pane's pid and current command in ONE tmux call, keyed by pane id (%N): the values `getPanePid` /
   *  `getPaneCommand` read per pane. Panes without a valid pid are left out (read those per pane). Null when tmux can't
   *  be read at all. The command is the LAST field, so a separator inside it stays intact. */
  async readAllPaneProcesses(): Promise<Map<string, { pid: number; command: string | null }> | null> {
    try {
      const format = ["#{pane_id}", "#{pane_pid}", "#{pane_current_command}"].join(TMUX_FIELD_SEPARATOR);
      const output = await this.run(["tmux", "list-panes", "-a", "-F", format], `tmux list-panes -a -F '${format}'`);
      const out = new Map<string, { pid: number; command: string | null }>();
      for (const line of output.split("\n")) {
        const first = line.indexOf(TMUX_FIELD_SEPARATOR), second = line.indexOf(TMUX_FIELD_SEPARATOR, first + 1);
        if (first <= 0 || second < 0) continue;
        const id = line.slice(0, first), pid = parseInt(line.slice(first + 1, second).trim(), 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        out.set(id, { pid, command: line.slice(second + 1).trim() || null });
      }
      return out;
    } catch {
      return null;
    }
  }

  async readPaneLastActivity(paneId: string): Promise<number | null> {
    try {
      const output = await this.run(
        ["tmux", "display-message", "-p", "-t", paneId, "#{window_activity}"],
        `tmux display-message -p -t ${shellQuote(paneId)} '#{window_activity}'`,
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
      return parseLines(output, parseClientLine);
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
    try {
      await this.run(["tmux", "switch-client", "-c", client, "-t", target],
        `tmux switch-client -c ${shellQuote(client)} -t ${shellQuote(target)}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }
}
