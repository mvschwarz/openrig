// OPR.0.4.6.PI1 — the pane-hosted pi-runner (compiled entry in the daemon dist).
//
// The runner is what makes a Pi seat behave like a normal OpenRig tmux seat
// while everything underneath stays structured RPC:
//
//   pane stdin (rig send / human typing)  ──▶ RPC prompt / steer / follow_up
//   pi RPC events (typed JSONL)           ──▶ (a) human-readable pane mirror
//                                             (b) activity + session_identity
//                                                 POSTs to the daemon
//                                             (c) runner-state.json sidecar
//
// BR-1: activity/session identity derive ONLY from Pi's typed events +
// get_state — never pane scraping. BR-3: the pi child gets a deny-by-default
// env allowlist. BR-5: the trust flag is always explicit. Honest failure:
// a dead pi process prints the EXIT/ERROR marker and records `exited` in the
// sidecar — never a silently frozen pane.
//
// Only node builtins + pi-runner-protocol are imported so the compiled entry
// stays runnable as `node <dist>/adapters/pi-runner.js` with no daemon deps.

import fs from "node:fs";
import nodePath from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { formatDaemonHostForUrl } from "./daemon-url.js";
import {
  piSeatPaths, buildPiChildArgs, buildPiChildEnv, buildPendingRunnerState, parsePiRunnerState,
  PI_RUNNER_READY_MARKER, PI_RUNNER_EXIT_MARKER, PI_RUNNER_ERROR_MARKER,
  type PiRunnerState, type RunnerRuntime,
} from "./pi-runner-protocol.js";

// ── Submitted input boundaries ─────────────────────────────────────────────
// Canonical TTY buffers can overflow before Node sees even the paste terminator.
// Use Node's line editor in raw mode, with only paste framing handled here.
export const MAX_PI_INPUT_BYTES = 1024 * 1024;

export function createRunnerInput(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  onSubmit: (block: string) => void,
): readline.Interface {
  const reject = () => output.write(
    "[pi-runner] input rejected: maximum 1048576 UTF-8 bytes; send a smaller message. Ctrl-C clears unfinished input.\n",
  );
  const submit = (block: string) => {
    if (Buffer.byteLength(block) > MAX_PI_INPUT_BYTES) reject();
    else if (block.trim()) onSubmit(block);
  };
  // A pipe has no kernel line limit or terminal editing; each line is a message.
  if (!input.isTTY || !output.isTTY) {
    return readline.createInterface({ input, crlfDelay: Infinity }).on("line", submit);
  }

  const keys = new PassThrough();
  const editor = readline.createInterface({
    input: keys, output, terminal: true, prompt: "", historySize: 0, crlfDelay: Infinity,
  });
  // Node forces dumb-terminal mode without editing if TERM=dumb. When terminal: true
  // was requested, remove the dumb-mode override so VT100 line editing is preserved.
  if (Object.prototype.hasOwnProperty.call(editor, "_ttyWrite")) {
    delete (editor as any)._ttyWrite;
  }
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let paste: string | null = null;
  let pasteBytes = 0;
  let discarded = false;
  const setLine = (line: string, cursor: number) => {
    // Node documents changing rl.line together with rl.cursor. The installed
    // typings mark them readonly, so assign this pair through one explicit seam.
    Object.assign(editor, { line, cursor });
    editor.prompt(true);
  };
  const clear = () => setLine("", 0);
  const consume = (text: string) => {
    if (paste === null) {
      keys.write(text);
    } else if (!discarded) {
      pasteBytes += Buffer.byteLength(text);
      if (pasteBytes > MAX_PI_INPUT_BYTES) {
        paste = "";
        discarded = true;
        clear();
        reject();
      } else paste += text;
    }
  };
  const receive = (chunk: Buffer) => {
    pending += decoder.write(chunk);
    while (pending) {
      const marker = paste === null ? "\u001b[200~" : "\u001b[201~";
      const boundary = pending.indexOf(marker);
      const interrupt = pending.indexOf("\u0003");
      const at = boundary < 0 ? interrupt : interrupt < 0 ? boundary : Math.min(boundary, interrupt);
      if (at < 0) {
        // Retain only a possible split marker; normal editing keys go to Node.
        let tail = Math.min(marker.length - 1, pending.length);
        while (tail && !marker.startsWith(pending.slice(-tail))) tail--;
        consume(pending.slice(0, pending.length - tail));
        pending = pending.slice(pending.length - tail);
        break;
      }
      consume(pending.slice(0, at));
      pending = pending.slice(at + (at === interrupt ? 1 : marker.length));
      if (at === interrupt) {
        paste = null;
        discarded = false;
        clear();
        output.write("\n[pi-runner] input cleared\n");
        onSubmit("/abort");
      } else if (paste === null) {
        paste = "";
        pasteBytes = 0;
        discarded = false;
      } else {
        if (!discarded) {
          const line = editor.line.slice(0, editor.cursor) + paste + editor.line.slice(editor.cursor);
          if (Buffer.byteLength(line) > MAX_PI_INPUT_BYTES) { clear(); reject(); }
          else {
            // rl.write(text) treats pasted newlines as submits. These public
            // editing fields insert the whole literal paste without submitting.
            setLine(line, editor.cursor + paste.length);
          }
        }
        paste = null;
      }
    }
  };
  const wasRaw = input.isRaw;
  const end = () => editor.close();
  input.setRawMode(true);
  output.write("\u001b[?2004h");
  input.on("data", receive);
  input.once("end", end);
  editor.on("line", submit);
  editor.once("close", () => {
    input.removeListener("data", receive);
    input.removeListener("end", end);
    input.setRawMode(wasRaw);
    input.pause();
    keys.destroy();
    output.write("\u001b[?2004l");
  });
  return editor;
}

// ── Pi event → mirror + activity mapping (pure, hermetically testable) ──────

export interface MirrorAndActivity {
  /** Lines to print to the pane (already human-readable). */
  mirrorLines: string[];
  /** Raw text to append to the current mirror line (streamed deltas). */
  mirrorAppend?: string;
  /** Activity POST payload (hookEvent/subtype), when the event maps to one. */
  activity?: { hookEvent: string; subtype: string | null };
  /** Streaming-state transition, when the event carries one. */
  streaming?: boolean;
  /** A typed terminal failure; the core coalesces its exhausted-retry notice. */
  errorNotice?: string;
}

function errorNotice(detail: unknown, runtime: RunnerRuntime): string {
  const text = typeof detail === "string"
    ? stripVTControlCharacters(detail).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim()
    : "";
  const marker = runtime === "omp" ? "[omp-runner] ERROR" : PI_RUNNER_ERROR_MARKER;
  return `${marker} ${text.slice(0, 400) || "request failed"}`;
}

/** The one model-failure detector for both runtimes. Pi and OMP report a
 *  provider/auth failure on the assistant message itself and still end the
 *  turn normally; OMP repeats the message on turn_end, and either runtime can
 *  announce it again when automatic retries exhaust. The core coalesces the
 *  repeats into one notice per failure. */
function modelErrorNotice(event: Record<string, unknown>, runtime: RunnerRuntime): { errorNotice?: string } {
  if (event.type === "auto_retry_end") {
    return event.success === false ? { errorNotice: errorNotice(event.finalError, runtime) } : {};
  }
  const message = event.message as Record<string, unknown> | undefined;
  return message?.role === "assistant" && message.stopReason === "error"
    ? { errorNotice: errorNotice(message.errorMessage, runtime) } : {};
}

export function mapPiEvent(event: Record<string, unknown>, runtime: RunnerRuntime = "pi"): MirrorAndActivity {
  const type = typeof event.type === "string" ? event.type : "";
  switch (type) {
    case "agent_start":
      return { mirrorLines: [], activity: { hookEvent: "active", subtype: "agent_start" }, streaming: true };
    case "agent_end":
      return runtime === "omp" && event.isTerminal === false
        ? { mirrorLines: [], streaming: true }
        : { mirrorLines: [""], activity: { hookEvent: "Stop", subtype: "agent_end" }, streaming: false };
    case "turn_end":
      // OMP repeats an assistant failure on turn_end (sometimes only there).
      // Pi keeps main's mapping: turn_end carries no notice.
      return runtime === "omp" ? { mirrorLines: [], ...modelErrorNotice(event, runtime) } : { mirrorLines: [] };
    case "turn_start":
    case "message_start":
      return { mirrorLines: [] };
    case "message_update": {
      // Pi streams assistant text as `assistantMessageEvent` text_delta
      // records. Only the delta is mirrored: Pi 0.84.0 dropped the cumulative
      // `message` from RPC message_update, and older Pi sent it alongside the
      // same deltas, so appending it repeated the growing text. Thinking and
      // tool-call argument deltas stay out of the pane; tool calls get their
      // own one-line summaries from tool_execution_*.
      const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
      const delta = update?.type === "text_delta" && typeof update.delta === "string" ? update.delta : "";
      return delta ? { mirrorLines: [], mirrorAppend: delta } : { mirrorLines: [] };
    }
    case "message_end":
      // The message text already streamed via message_update appends; this
      // terminates the line. (mapPiEvent is stateless, so a hypothetical
      // updates-carried-nothing case is a VM-calibration follow-up, not
      // silently guessed here.)
      return { mirrorLines: [""], ...modelErrorNotice(event, runtime) };
    case "tool_execution_start": {
      const tool = typeof event.toolName === "string" ? event.toolName : (typeof event.name === "string" ? event.name : "tool");
      return { mirrorLines: [`  ⚙ ${tool} …`], activity: { hookEvent: "PreToolUse", subtype: tool } };
    }
    case "tool_execution_end": {
      const tool = typeof event.toolName === "string" ? event.toolName : (typeof event.name === "string" ? event.name : "tool");
      const failed = event.isError === true || event.error != null;
      return { mirrorLines: [`  ⚙ ${tool} ${failed ? "FAILED" : "done"}`] };
    }
    case "queue_update":
      return { mirrorLines: [] };
    case "compaction_start":
      return { mirrorLines: [`[${runtime}] compacting context…`], activity: { hookEvent: "active", subtype: "compaction" } };
    case "compaction_end":
      return { mirrorLines: [`[${runtime}] compaction done`] };
    // OMP names its automatic compaction separately. Pi keeps main's mapping
    // (unmapped), so an idle Pi seat never reads as running after one.
    case "auto_compaction_start":
      return runtime === "omp"
        ? { mirrorLines: ["[omp] compacting context…"], activity: { hookEvent: "active", subtype: "compaction" } }
        : { mirrorLines: [] };
    case "auto_compaction_end":
      return runtime === "omp" ? { mirrorLines: ["[omp] compaction done"] } : { mirrorLines: [] };
    case "auto_retry_start":
      return { mirrorLines: ["[pi] transient error — retrying"], activity: { hookEvent: "active", subtype: "auto_retry" } };
    case "auto_retry_end": {
      const notice = modelErrorNotice(event, runtime);
      return notice.errorNotice ? { mirrorLines: [""], ...notice } : { mirrorLines: [] };
    }
    case "extension_error": {
      const message = typeof event.message === "string" ? event.message : "extension error";
      return { mirrorLines: [`${PI_RUNNER_ERROR_MARKER} extension: ${message}`] };
    }
    default:
      return { mirrorLines: [] };
  }
}

// ── The runner core (injected effects; owns protocol state) ─────────────────

export interface RunnerIo {
  /** Write one JSONL command to pi stdin. */
  sendRpc(cmd: Record<string, unknown>): void;
  /** Print a full line to the pane. */
  mirrorLine(line: string): void;
  /** Append raw text to the current pane line (streamed deltas). */
  mirrorAppend(text: string): void;
  /** POST to the daemon activity endpoint. May resolve to the parsed JSON
   *  response (null on transport failure) so identity delivery can retry. */
  postActivity(payload: Record<string, unknown>): void | Promise<Record<string, unknown> | null>;
  /** Persist the runner-state sidecar. */
  writeSidecar(state: PiRunnerState): void;
  /** OMP can announce a path before a session file exists. */
  sessionFileExists?(path: string): boolean;
  /** Terminate OMP when get_state cannot establish a resumable seat. */
  stopChild?(): void;
  now(): string;
}

const GET_STATE_ID = "pi-runner-get-state";
const CATCH_UP_ID = "pi-runner-catch-up";
const CURSOR_REFRESH_ID = "pi-runner-cursor-refresh";
/** RPC commands that carry operator input. Their failure means the seat
 *  cannot do the requested work; other command failures are not attention. */
const INPUT_COMMANDS: Record<string, true> = { prompt: true, steer: true, follow_up: true };

export class RunnerCore {
  private streaming = false;
  private sessionFile: string | undefined;
  private sessionId: string | undefined;
  private lastEntryId: string | undefined;
  private ready = false;
  private assistantErrorShown = false;
  private started = false;
  /** OMP attention (runtime_error | permission_prompt) that must survive the
   *  end of the turn; cleared by the next agent_start. */
  private attention: "runtime_error" | "permission_prompt" | null = null;
  /** Whether the last activity posted is that attention. Later activity in
   *  the same turn (a tool call after a denied approval) replaces it. */
  private attentionIsLatest = false;
  /** Set once the daemon confirms it persisted the resume token. */
  private identityPersisted = false;
  private identityInFlight = false;

  constructor(
    private io: RunnerIo,
    private identity: { sessionName: string; nodeId?: string; launchId?: string; generation?: string },
    private opts: { catchUpSince?: string; runtime?: RunnerRuntime } = {},
  ) {
    // The durable cursor seeds from the carried-over value (FR-5) so this
    // instance's own sidecar writes never regress it to undefined before a
    // newer entry supersedes it.
    this.lastEntryId = opts.catchUpSince;
  }
  /** Runner readiness is the sidecar's acknowledged get_state, not RPC transport ready. */
  isReady(): boolean { return this.ready; }

  /** Kick off identity capture. Called once pi's RPC stream is up. */
  start(): void {
    // OMP's start is driven by the transport `ready` frame and must run once;
    // Pi keeps main's unconditional start.
    if (this.runtime === "omp") {
      if (this.started) return;
      this.started = true;
    }
    this.io.sendRpc({ type: "get_state", id: GET_STATE_ID });
    if (this.opts.catchUpSince) {
      // Durable catch-up cursor (FR-5): replay session entries the previous
      // runner instance had not yet projected. Mirror-only; activity states
      // are live-only signals.
      this.io.sendRpc({ type: "get_entries", since: this.opts.catchUpSince, id: CATCH_UP_ID });
    }
  }

  /** One LF-delimited JSONL record from pi stdout. */
  handlePiLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      record = parsed as Record<string, unknown>;
    } catch {
      // Non-JSON noise on pi stdout — mirror it verbatim so nothing hides.
      this.io.mirrorLine(line);
      return;
    }

    if (record.type === "response") {
      this.handleResponse(record);
      return;
    }
    this.handleEvent(record);
  }

  private get runtime(): RunnerRuntime { return this.opts.runtime ?? "pi"; }

  /** One aggregated paste block from pane stdin. */
  handleUserBlock(block: string): void {
    if (block === "/abort") {
      this.io.sendRpc({ type: "abort" });
      this.io.mirrorLine("[pi-runner] abort sent");
      return;
    }
    if (block.startsWith("/followup ")) {
      const message = block.slice("/followup ".length);
      this.io.sendRpc({ type: "follow_up", message });
      this.io.mirrorLine(`you (follow-up) ▸ ${message}`);
      return;
    }
    if (this.streaming) {
      // Mid-stream: steer delivers after the current turn's tool calls,
      // before the next model call (Pi's documented semantics).
      this.io.sendRpc({ type: "steer", message: block });
      this.io.mirrorLine(`you (steer) ▸ ${block}`);
      return;
    }
    this.io.sendRpc({ type: "prompt", message: block });
    this.io.mirrorLine(`you ▸ ${block}`);
  }

  /** Child process exit — honest, loud, durable. */
  handlePiExit(code: number | null): void {
    this.ready = false;
    this.io.mirrorLine(`[${this.runtime}-runner] EXITED ${this.runtime} exited (code ${code ?? "unknown"})`);
    this.writeSidecar({ exited: { code, at: this.io.now() } });
    this.io.postActivity(this.activityPayload("Stop", `${this.runtime}_exited`));
  }

  private handleResponse(record: Record<string, unknown>): void {
    if (record.success === false || record.error != null) {
      const message = typeof record.error === "string" ? record.error : "request failed";
      if (record.id === GET_STATE_ID) {
        this.ready = false;
        this.writeSidecar({});
        this.io.mirrorLine(this.runtime === "omp" ? `[omp-runner] ERROR rpc get_state: ${message}` : `${PI_RUNNER_ERROR_MARKER} rpc: ${message}`);
        // OMP cannot provide a resume token without get_state; stop it so the
        // launch fails now instead of waiting out readiness.
        if (this.runtime === "omp") this.io.stopChild?.();
        return;
      }
      this.io.mirrorLine(`[${this.runtime}-runner] ERROR rpc: ${message}`);
      // Only a rejected input means the seat cannot do the requested work.
      // A mistimed /abort (or any control command) leaves the seat idle.
      if (this.runtime === "omp" && typeof record.command === "string" && Object.hasOwn(INPUT_COMMANDS, record.command)) {
        this.raiseAttention("runtime_error");
      }
      return;
    }
    if (record.id === GET_STATE_ID) {
      const data = (record.data ?? record.state ?? record) as Record<string, unknown>;
      const sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : undefined;
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
      this.sessionFile = sessionFile ?? this.sessionFile;
      this.sessionId = sessionId ?? this.sessionId;
      this.ready = this.runtime === "pi" || !!this.sessionFile;
      if (!this.ready) {
        this.io.mirrorLine("[omp-runner] ERROR rpc get_state returned no session file; cannot provide a resume token");
        this.io.stopChild?.();
        return;
      }
      this.writeSidecar({});
      this.io.mirrorLine(`${this.runtime === "omp" ? "[omp-runner] READY" : PI_RUNNER_READY_MARKER} session=${this.sessionFile ?? "unknown"}`);
      this.postSessionIdentity();
      return;
    }
    if (record.id === CURSOR_REFRESH_ID || record.id === CATCH_UP_ID) {
      const data = (record.data ?? record) as Record<string, unknown>;
      const entries = Array.isArray(data.entries) ? data.entries : (Array.isArray(record.entries) ? record.entries : []);
      const last = entries.at(-1);
      const lastId = last !== null && typeof last === "object" && typeof (last as Record<string, unknown>).id === "string"
        ? (last as Record<string, unknown>).id as string
        : undefined;
      if (lastId) {
        this.lastEntryId = lastId;
        this.writeSidecar({});
      }
      return;
    }
  }

  private raiseAttention(subtype: "runtime_error" | "permission_prompt"): void {
    // Runtime failures outrank denied approvals. Only emit when the visible
    // attention changes or intervening activity replaced it.
    const next = this.attention === "runtime_error" ? this.attention : subtype;
    if (this.attention === next && this.attentionIsLatest) return;
    this.attention = next;
    this.attentionIsLatest = true;
    this.io.postActivity(this.activityPayload("Notification", next));
  }

  private clearAttention(): void {
    this.attention = null;
    this.attentionIsLatest = false;
  }

  private handleEvent(event: Record<string, unknown>): void {
    if (this.runtime === "omp" && event.type === "extension_ui_request") {
      const method = event.method;
      // RPC does not mount an interactive UI. Reply at once; otherwise the
      // child can wait forever for approval that cannot be given in the pane.
      if (typeof event.id === "string") {
        this.io.sendRpc({ type: "extension_ui_response", id: event.id, cancelled: true });
      }
      if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
        this.io.mirrorLine("[omp-runner] Approval/input requested; cancelled because the managed RPC pane cannot answer it. Operator action required: review the denied action and re-send a safe instruction, or change the seat permission policy explicitly.");
        this.raiseAttention("permission_prompt");
      }
      return;
    }
    const message = event.message as Record<string, unknown> | undefined;
    if (event.type === "agent_start" || (event.type === "message_start" && message?.role === "assistant")) {
      this.assistantErrorShown = false;
    }
    // Durable cursor: any event carrying a session-entry id advances it.
    const entryId = typeof event.entryId === "string" ? event.entryId : (typeof event.id === "string" ? event.id : undefined);
    if (entryId) {
      this.lastEntryId = entryId;
      this.writeSidecar({});
    }

    if (this.runtime === "omp") {
      if (event.type === "agent_start") this.clearAttention();
      // A successful automatic retry supersedes the failed attempt.
      if (event.type === "auto_retry_start" && this.attention === "runtime_error") this.clearAttention();
      // Some paths omit agent_start; turn_start still opens a new turn.
      if (event.type === "turn_start") this.assistantErrorShown = false;
    }
    const mapped = mapPiEvent(event, this.runtime);
    if (mapped.streaming !== undefined) this.streaming = mapped.streaming;
    // OMP writes its JSONL lazily; re-announce identity after each turn until
    // the daemon confirms the token. Pi's get_state identity is final.
    if (event.type === "agent_end" && this.runtime === "omp") this.postSessionIdentity();
    if (event.type === "agent_end") {
      // QA RED fold (qitem-20260707020922): live events do not reliably carry
      // session-entry ids, so the durable cursor starved (lastEntryId stayed
      // null in real runs). Refresh it from the source of truth after every
      // completed turn — get_entries returns append-order entries with stable
      // ids; the response handler advances the cursor from the tail.
      this.io.sendRpc({ type: "get_entries", id: CURSOR_REFRESH_ID });
    }
    if (mapped.mirrorAppend) this.io.mirrorAppend(mapped.mirrorAppend);
    for (const line of mapped.mirrorLines) this.io.mirrorLine(line);
    if (mapped.errorNotice) {
      // Pi can announce the same failed message again when retries exhaust,
      // and OMP repeats it on turn_end. Keep the first useful detail even if
      // the repeat lacks it, then reset at the next assistant message/agent
      // turn, not at agent_end.
      if (event.type === "message_end" || !this.assistantErrorShown) {
        this.io.mirrorLine(mapped.errorNotice);
      }
      this.assistantErrorShown = true;
      // OMP still ends the turn normally after a model failure; the operator
      // has to act, so the seat shows attention rather than idle.
      if (this.runtime === "omp") this.raiseAttention("runtime_error");
    }
    if (!mapped.activity) return;
    if (mapped.activity.hookEvent === "Stop" && this.attention) {
      // The turn ended, but the operator still has to act. Drop the Stop; if
      // later activity replaced the attention, restore it as the final state.
      if (!this.attentionIsLatest) this.raiseAttention(this.attention);
    } else {
      this.attentionIsLatest = false;
      this.io.postActivity(this.activityPayload(mapped.activity.hookEvent, mapped.activity.subtype));
    }
  }

  /** Re-deliver OMP identity until the daemon confirms the resume token.
   *  Called from a timer so a daemon restart during the first turn cannot
   *  leave a seat with history but no restorable token. */
  retrySessionIdentity(): void {
    if (this.runtime === "omp" && this.ready) this.postSessionIdentity();
  }

  private postSessionIdentity(): void {
    if (this.runtime === "omp" && (!this.sessionFile || !this.io.sessionFileExists?.(this.sessionFile))) return;
    if (this.runtime === "omp" && (this.identityPersisted || this.identityInFlight)) return;
    const result = this.io.postActivity({
      eventFamily: "session_identity",
      sessionName: this.identity.sessionName,
      nodeId: this.identity.nodeId ?? null,
      runtime: this.runtime,
      generation: this.identity.generation ?? null,
      hookEvent: "SessionStart",
      sessionId: this.sessionId ?? "unknown",
      sessionFile: this.sessionFile ?? null,
      occurredAt: this.io.now(),
    });
    if (this.runtime !== "omp" || !result) return;
    this.identityInFlight = true;
    void result.then(
      (body) => { if (body?.tokenPersisted === true) this.identityPersisted = true; },
      () => { /* unacknowledged; the next agent_end or retry tick re-posts */ },
    ).finally(() => { this.identityInFlight = false; });
  }

  private activityPayload(hookEvent: string, subtype: string | null): Record<string, unknown> {
    return {
      sessionName: this.identity.sessionName,
      nodeId: this.identity.nodeId ?? null,
      generation: this.identity.generation ?? null,
      runtime: this.runtime,
      hookEvent,
      subtype,
      occurredAt: this.io.now(),
    };
  }

  private writeSidecar(patch: Partial<PiRunnerState>): void {
    this.io.writeSidecar({
      ready: this.ready,
      // Launch-attempt scope: every write is stamped so the daemon can
      // distinguish THIS runner instance's truth from stale artifacts.
      launchId: this.identity.launchId,
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      lastEntryId: this.lastEntryId,
      updatedAt: this.io.now(),
      ...patch,
    });
  }
}

// ── CLI entry ────────────────────────────────────────────────────────────────

interface RunnerArgs {
  runtime?: RunnerRuntime;
  sessionName: string;
  stateRoot: string;
  cwd: string;
  launchId: string;
  model?: string;
  trust: "approve" | "no-approve";
  sessionFile?: string;
  forkRef?: string;
}

export function parseRunnerArgs(argv: string[]): RunnerArgs {
  const args: Partial<RunnerArgs> & { trust?: "approve" | "no-approve" } = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    switch (flag) {
      case "--session-name": args.sessionName = next(); break;
      case "--runtime": {
        const runtime = next();
        if (runtime !== "pi" && runtime !== "omp") throw new Error(`unsupported runtime: ${runtime}`);
        args.runtime = runtime;
        break;
      }
      case "--state-root": args.stateRoot = next(); break;
      case "--cwd": args.cwd = next(); break;
      case "--launch-id": args.launchId = next(); break;
      case "--model": args.model = next(); break;
      case "--session": args.sessionFile = next(); break;
      case "--fork": args.forkRef = next(); break;
      case "--approve": args.trust = "approve"; break;
      case "--no-approve": args.trust = "no-approve"; break;
      case "--approval-mode": {
        const mode = next();
        if (mode !== "yolo" && mode !== "always-ask") throw new Error(`unsupported OMP approval mode: ${mode}`);
        args.trust = mode === "yolo" ? "approve" : "no-approve";
        break;
      }
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!args.sessionName) throw new Error("--session-name is required");
  if (!args.stateRoot) throw new Error("--state-root is required");
  if (!args.cwd) throw new Error("--cwd is required");
  if (!args.launchId) throw new Error("--launch-id is required (launch-attempt scoping)");
  if (args.runtime === "omp") {
    if (!argv.includes("--approval-mode") || argv.some((flag) => flag === "--approve" || flag === "--no-approve")) {
      throw new Error("OMP requires --approval-mode yolo or always-ask, not Pi trust flags");
    }
  } else if (!args.trust || argv.includes("--approval-mode")) {
    throw new Error("an explicit trust flag is required: --approve or --no-approve");
  }
  if (args.sessionFile && args.forkRef) throw new Error("--session and --fork are mutually exclusive");
  return args as RunnerArgs;
}

function resolveActivityEndpoint(env: NodeJS.ProcessEnv): { baseUrl: string; token: string } | null {
  let baseUrl = env.OPENRIG_URL?.trim() || null;
  let token = env.OPENRIG_ACTIVITY_HOOK_TOKEN?.trim() || null;
  if (!baseUrl && env.OPENRIG_PORT) {
    const rawHost = env.OPENRIG_HOST?.trim() || "127.0.0.1";
    baseUrl = `http://${formatDaemonHostForUrl(rawHost)}:${env.OPENRIG_PORT.trim()}`;
  }
  if (!baseUrl || !token) {
    try {
      const home = env.OPENRIG_HOME?.trim() || nodePath.join(process.env.HOME ?? "", ".openrig");
      const parsed = JSON.parse(fs.readFileSync(nodePath.join(home, "activity-endpoint.json"), "utf8"));
      if (!baseUrl && typeof parsed.baseUrl === "string") baseUrl = parsed.baseUrl;
      if (!token && typeof parsed.token === "string") token = parsed.token;
    } catch {
      // absent/malformed — activity POSTs no-op; the sidecar + mirror still work.
    }
  }
  return baseUrl && token ? { baseUrl, token } : null;
}

/** The runner-side sidecar handshake, extracted for hermetic testing (guard
 *  re-verdict, qitem-20260707013815): read the PRIOR record's durable cursor
 *  FIRST, then stamp the launch-scoped pending record — the write carries the
 *  cursor forward so no reset in the chain can erase it. `catchUpSince` is
 *  only surfaced when resuming: a fresh/fork session has no prior projection
 *  to catch up. */
export function prepareRunnerSidecar(
  fsOps: { readFile(p: string): string; writeFile(p: string, c: string): void; exists(p: string): boolean },
  runnerStatePath: string,
  launchId: string,
  resuming: boolean,
  now: () => string,
): { catchUpSince: string | undefined } {
  let prior: PiRunnerState | null = null;
  try {
    prior = fsOps.exists(runnerStatePath) ? parsePiRunnerState(fsOps.readFile(runnerStatePath)) : null;
  } catch { /* unreadable prior sidecar — treated as absent */ }
  try {
    fsOps.writeFile(runnerStatePath, JSON.stringify(buildPendingRunnerState(launchId, now(), prior)));
  } catch { /* best-effort; the adapter pre-writes an equivalent pending record */ }
  return { catchUpSince: resuming ? prior?.lastEntryId : undefined };
}

/** How often an OMP runner re-delivers an unconfirmed session identity. */
const IDENTITY_RETRY_MS = 30_000;

export interface ExecutableResolverOps {
  isExecutable(path: string): boolean;
  realpath(path: string): string;
  /** Run a launcher (argv, no shell) and return its trimmed stdout. */
  run(file: string, args: string[], env: NodeJS.ProcessEnv): string;
}

const nodeResolverOps: ExecutableResolverOps = {
  isExecutable: (path) => {
    try {
      fs.accessSync(path, fs.constants.X_OK);
      return fs.statSync(path).isFile();
    } catch {
      return false;
    }
  },
  realpath: (path) => fs.realpathSync(path),
  run: (file, args, env) => execFileSync(file, args, { env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim(),
};

/** Resolve `name` to the absolute path of the real binary, using the
 *  runner's own environment. The child later runs under a per-seat HOME, and
 *  version-manager shims (mise) find their target through HOME, so the shim
 *  itself must never be what the child executes. */
export function resolveRuntimeExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  ops: ExecutableResolverOps = nodeResolverOps,
  cwd?: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const onPath = (env.PATH ?? "").split(nodePath.delimiter)
    .filter((dir) => cwd !== undefined || nodePath.isAbsolute(dir))
    .map((dir) => cwd === undefined ? nodePath.join(dir, name) : nodePath.resolve(cwd, dir, name))
    .find((candidate) => ops.isExecutable(candidate));
  if (!onPath) return { ok: false, error: `'${name}' was not found on PATH (${env.PATH ?? ""})` };
  let real: string;
  try {
    real = ops.realpath(onPath);
  } catch (err) {
    return { ok: false, error: `could not resolve ${onPath}: ${(err as Error).message}` };
  }
  if (nodePath.basename(real) !== "mise") return { ok: true, path: real };
  // A mise shim is a symlink to mise itself; ask mise for the tool it maps to.
  let target: string;
  try {
    target = ops.run(real, ["which", name], env);
  } catch (err) {
    return { ok: false, error: `${onPath} is a mise shim and 'mise which ${name}' failed: ${(err as Error).message}` };
  }
  if (!nodePath.isAbsolute(target) || !ops.isExecutable(target)) {
    return { ok: false, error: `${onPath} is a mise shim but 'mise which ${name}' returned no executable (${target || "empty"})` };
  }
  try {
    return { ok: true, path: ops.realpath(target) };
  } catch (err) {
    return { ok: false, error: `could not resolve ${target}: ${(err as Error).message}` };
  }
}

/** Enrich an actual CLI rejection, without guessing compatibility from a version
 * or from help (older Pi prints help before validating unknown long flags). */
export function piLaunchCapabilityError(
  command: string,
  trust: "approve" | "no-approve",
  line: string,
  readVersion: () => string,
): string | undefined {
  const diagnostic = stripVTControlCharacters(line);
  if (!/unknown options?:/i.test(diagnostic) || !/--(?:name|approve|no-approve)(?=[\s,.:]|$)/.test(diagnostic)) return;
  let version = "unknown version";
  try {
    const value = readVersion().trim();
    if (/^[0-9][A-Za-z0-9.+_-]{0,63}$/.test(value)) version = `version ${value}`;
  } catch { /* diagnostics only; never changes the child's outcome */ }
  return `Pi at ${command} (${version}) rejects the managed --name/--${trust} flags. Install the current @earendil-works/pi-coding-agent (npm install -g @earendil-works/pi-coding-agent) and check 'command -v pi' in this pane; an older Pi installation may be shadowing it.`;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args: RunnerArgs;
  try {
    args = parseRunnerArgs(argv);
  } catch (err) {
    console.error(`${PI_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  const runtime = args.runtime ?? "pi";
  const paths = piSeatPaths(args.stateRoot, args.sessionName);
  fs.mkdirSync(paths.agentDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });

  const { catchUpSince } = prepareRunnerSidecar(
    {
      readFile: (p) => fs.readFileSync(p, "utf8"),
      writeFile: (p, c) => fs.writeFileSync(p, c),
      exists: (p) => fs.existsSync(p),
    },
    paths.runnerStatePath,
    args.launchId,
    !!args.sessionFile,
    () => new Date().toISOString(),
  );

  const endpoint = resolveActivityEndpoint(process.env);
  const childEnv = buildPiChildEnv(process.env as Record<string, string | undefined>, {
    agentDir: paths.agentDir,
    sessionsDir: paths.sessionsDir,
    model: args.model,
    runtime,
    sessionName: args.sessionName,
    nodeId: process.env.OPENRIG_NODE_ID,
    openrigHome: process.env.OPENRIG_HOME,
    openrigUrl: endpoint?.baseUrl ?? process.env.OPENRIG_URL,
  });
  const childArgs = buildPiChildArgs({
    sessionsDir: paths.sessionsDir,
    sessionName: args.sessionName,
    model: args.model,
    trust: args.trust,
    sessionFile: args.sessionFile,
    forkRef: args.forkRef,
    runtime,
  });

  console.log(`[${runtime}-runner] starting ${runtime} --mode rpc (seat ${args.sessionName})`);
  console.log(`[${runtime}-runner] send text normally; prefixes: "/followup <text>" queues after the turn, "/abort" cancels`);

  // Resolve inside the pane. OMP needs the original HOME for mise shims; Pi
  // also preserves relative PATH entries against the actual child cwd.
  let command: string = runtime;
  {
    const resolved = resolveRuntimeExecutable(runtime, process.env, nodeResolverOps, runtime === "pi" ? args.cwd : undefined);
    if (!resolved.ok) {
      console.error(`[${runtime}-runner] ERROR launch: ${resolved.error}`);
      // Record the exit for this launch so the adapter fails it now instead
      // of waiting out its readiness timeout. The durable cursor survives.
      const at = new Date().toISOString();
      try {
        const pending = parsePiRunnerState(fs.readFileSync(paths.runnerStatePath, "utf8"));
        const exitedState: PiRunnerState = { ready: false, launchId: args.launchId, lastEntryId: pending?.lastEntryId, updatedAt: at, exited: { code: 127, at } };
        fs.writeFileSync(paths.runnerStatePath, JSON.stringify(exitedState));
      } catch { /* the pane ERROR marker still fails readiness */ }
      process.exitCode = 127;
      return;
    }
    command = resolved.path;
  }

  const child = spawn(command, childArgs, {
    cwd: args.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const io: RunnerIo = {
    sendRpc: (cmd) => {
      try { child.stdin.write(`${JSON.stringify(cmd)}\n`); } catch { /* exit handler reports */ }
    },
    mirrorLine: (line) => process.stdout.write(`${line}\n`),
    mirrorAppend: (text) => process.stdout.write(text),
    postActivity: (payload) => {
      if (!endpoint || typeof fetch !== "function") return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const request = fetch(new URL("/api/activity/hooks", endpoint.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (runtime !== "omp") {
        request.catch(() => { /* best-effort — never blocks the loop */ }).finally(() => clearTimeout(timeout));
        return;
      }
      // OMP reads the acknowledgement so identity delivery can retry; null
      // (transport failure or a non-OK reply) means "not yet persisted".
      return request
        .then(async (response) => response.ok ? await response.json() as Record<string, unknown> : null)
        .catch(() => null)
        .finally(() => clearTimeout(timeout));
    },
    writeSidecar: (state) => {
      try {
        fs.writeFileSync(paths.runnerStatePath, JSON.stringify(state));
      } catch { /* best-effort; adapter falls back to pane markers */ }
    },
    now: () => new Date().toISOString(),
    stopChild: () => { child.kill(); },
    sessionFileExists: (path) => fs.existsSync(path),
  };

  const core = new RunnerCore(io, {
    sessionName: args.sessionName, nodeId: process.env.OPENRIG_NODE_ID, launchId: args.launchId,
    // Carry the emitting tenure; never infer it from a later daemon read or Pi event.
    generation: process.env.OPENRIG_OCCUPANT_GENERATION,
  }, { catchUpSince, runtime });

  let transportUp = runtime === "pi";
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (runtime === "omp" && !core.isReady()) {
      try {
        const frame = JSON.parse(line) as { type?: string };
        if (frame.type === "ready") {
          transportUp = true;
          core.start();
        }
      } catch { /* surface non-JSON stdout through the core */ }
    }
    core.handlePiLine(line);
  });
  // Re-deliver OMP identity until the daemon confirms the resume token.
  const identityRetry = runtime === "omp" ? setInterval(() => core.retrySessionIdentity(), IDENTITY_RETRY_MS) : undefined;
  identityRetry?.unref();
  let reportedPiCapability = false;
  readline.createInterface({ input: child.stderr }).on("line", (line) => {
    if (line.trim()) process.stdout.write(`[${runtime}:err] ${line}\n`);
    if (runtime === "pi" && !reportedPiCapability) {
      const detail = piLaunchCapabilityError(command, args.trust, line, () =>
        execFileSync(command, ["--version"], { cwd: args.cwd, env: childEnv, encoding: "utf8",
          timeout: 3000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] }));
      if (detail) {
        reportedPiCapability = true;
        process.stdout.write(`[pi-runner] ${detail}\n`);
      }
    }
  });
  const input = createRunnerInput(process.stdin, process.stdout, (block) => core.handleUserBlock(block));

  if (runtime === "pi") {
    child.on("error", (err) => {
      console.error(`${PI_RUNNER_ERROR_MARKER} failed to spawn pi: ${err.message}`);
      core.handlePiExit(null);
      input.close();
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      core.handlePiExit(code);
      input.close();
      process.exitCode = code ?? 1;
    });
    core.start();
    return;
  }

  // OMP: one exit record per launch, with a launch-vs-credential diagnosis
  // when the RPC session never became resumable.
  let exited = false;
  const recordExit = (code: number | null): void => {
    if (exited) return;
    exited = true;
    clearInterval(identityRetry);
    if (!core.isReady()) {
      console.error(transportUp
        ? "[omp-runner] ERROR OMP did not establish a resumable RPC session. Authenticate this isolated seat using HOME=<seat-root> PI_CODING_AGENT_DIR=<seat-root>/agent omp and /login, or provide its declared model provider key in the OpenRig daemon environment. Default OMP credentials are not shared."
        : `[omp-runner] ERROR OMP exited before its RPC transport started (${command}, code ${code ?? "unknown"}). This is a launch failure, not a credential problem; see the output above.`);
    }
    core.handlePiExit(code);
    input.close();
    process.exitCode = code ?? 1;
  };
  child.on("error", (err) => {
    console.error(`[omp-runner] ERROR failed to spawn omp: ${err.message}`);
    recordExit(null);
  });
  child.on("exit", recordExit);
}

// Compiled-entry guard: run main() only when executed directly (not imported
// by tests). import.meta.url === file URL of process.argv[1] when direct.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    // pathToFileURL handles percent-encoding (spaces etc.) the way
    // import.meta.url does — a hand-built `file://${path}` string does not.
    return import.meta.url === pathToFileURL(nodePath.resolve(entry)).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  void main();
}
