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
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  piSeatPaths, buildPiChildArgs, buildPiChildEnv, buildPendingRunnerState, parsePiRunnerState,
  PI_RUNNER_READY_MARKER, PI_RUNNER_EXIT_MARKER, PI_RUNNER_ERROR_MARKER,
  type PiRunnerState,
} from "./pi-runner-protocol.js";

// ── Paste aggregation (arch n1) ──────────────────────────────────────────────
// `rig send` delivers a multi-line body via send-keys -l and THEN a separate
// Enter, so a multi-line paste arrives as several stdin lines in quick
// succession. The aggregator treats the whole quiet-window batch as ONE
// prompt — never N prompts.

export class PasteAggregator {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private onFlush: (block: string) => void,
    // 600ms: the daemon transport's two-step send pastes the body, waits
    // 200ms, THEN submits Enter — so the final line's newline arrives ~200ms
    // after the paste. A 200ms quiet window raced that gap and split one
    // rig-send envelope into two prompts (VM leg-4 finding); 3x the transport
    // gap absorbs it while staying far below human message cadence.
    private quietMs = 600,
    private schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private cancel: (t: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) {}

  addLine(line: string): void {
    this.buffer.push(line);
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule(() => this.flush(), this.quietMs);
  }

  flush(): void {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const block = this.buffer.join("\n").trim();
    this.buffer = [];
    if (block.length > 0) this.onFlush(block);
  }
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
}

/** Tolerant text extraction from a Pi message shape (string, {text}, or
 *  content-block arrays). Exact field calibration is a VM-proof concern; this
 *  covers the documented shapes without throwing on unknowns. */
export function extractMessageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (message === null || typeof message !== "object") return "";
  const m = message as Record<string, unknown>;
  if (typeof m.text === "string") return m.text;
  if (Array.isArray(m.content)) {
    return m.content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block !== null && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
          return (block as Record<string, unknown>).text as string;
        }
        return "";
      })
      .join("");
  }
  if (typeof m.content === "string") return m.content;
  return "";
}

export function mapPiEvent(event: Record<string, unknown>): MirrorAndActivity {
  const type = typeof event.type === "string" ? event.type : "";
  switch (type) {
    case "agent_start":
      return { mirrorLines: [], activity: { hookEvent: "active", subtype: "agent_start" }, streaming: true };
    case "agent_end":
      return { mirrorLines: [""], activity: { hookEvent: "Stop", subtype: "agent_end" }, streaming: false };
    case "turn_start":
    case "turn_end":
    case "message_start":
      return { mirrorLines: [] };
    case "message_update": {
      const delta = extractMessageText(event.message ?? event.delta);
      return delta ? { mirrorLines: [], mirrorAppend: delta } : { mirrorLines: [] };
    }
    case "message_end": {
      // The message text already streamed via message_update appends; this
      // terminates the line. (mapPiEvent is stateless, so a hypothetical
      // updates-carried-nothing case is a VM-calibration follow-up, not
      // silently guessed here.)
      return { mirrorLines: [""] };
    }
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
      return { mirrorLines: ["[pi] compacting context…"], activity: { hookEvent: "active", subtype: "compaction" } };
    case "compaction_end":
      return { mirrorLines: ["[pi] compaction done"] };
    case "auto_retry_start":
      return { mirrorLines: ["[pi] transient error — retrying"], activity: { hookEvent: "active", subtype: "auto_retry" } };
    case "auto_retry_end":
      return { mirrorLines: [] };
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
  /** Fire-and-forget POST to the daemon activity endpoint. */
  postActivity(payload: Record<string, unknown>): void;
  /** Persist the runner-state sidecar. */
  writeSidecar(state: PiRunnerState): void;
  now(): string;
}

const GET_STATE_ID = "pi-runner-get-state";
const CATCH_UP_ID = "pi-runner-catch-up";
const CURSOR_REFRESH_ID = "pi-runner-cursor-refresh";

export class RunnerCore {
  private streaming = false;
  private sessionFile: string | undefined;
  private sessionId: string | undefined;
  private lastEntryId: string | undefined;
  private ready = false;

  constructor(
    private io: RunnerIo,
    private identity: { sessionName: string; nodeId?: string; launchId?: string },
    private opts: { catchUpSince?: string } = {},
  ) {
    // The durable cursor seeds from the carried-over value (FR-5) so this
    // instance's own sidecar writes never regress it to undefined before a
    // newer entry supersedes it.
    this.lastEntryId = opts.catchUpSince;
  }

  /** Kick off identity capture. Called once pi's RPC stream is up. */
  start(): void {
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

  /** Pi process exit — honest, loud, durable. */
  handlePiExit(code: number | null): void {
    this.ready = false;
    this.io.mirrorLine(`${PI_RUNNER_EXIT_MARKER} pi exited (code ${code ?? "unknown"})`);
    this.writeSidecar({ exited: { code, at: this.io.now() } });
    this.io.postActivity(this.activityPayload("Stop", "pi_exited"));
  }

  private handleResponse(record: Record<string, unknown>): void {
    if (record.id === GET_STATE_ID) {
      const data = (record.data ?? record.state ?? record) as Record<string, unknown>;
      const sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : undefined;
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
      this.sessionFile = sessionFile ?? this.sessionFile;
      this.sessionId = sessionId ?? this.sessionId;
      this.ready = true;
      this.writeSidecar({});
      this.io.mirrorLine(`${PI_RUNNER_READY_MARKER} session=${this.sessionFile ?? "unknown"}`);
      this.io.postActivity({
        eventFamily: "session_identity",
        sessionName: this.identity.sessionName,
        nodeId: this.identity.nodeId ?? null,
        runtime: "pi",
        hookEvent: "SessionStart",
        sessionId: this.sessionId ?? "unknown",
        sessionFile: this.sessionFile ?? null,
        occurredAt: this.io.now(),
      });
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
    // Other responses (prompt accepted, …) — surface errors.
    if (record.success === false || record.error != null) {
      const message = typeof record.error === "string" ? record.error : "request failed";
      this.io.mirrorLine(`${PI_RUNNER_ERROR_MARKER} rpc: ${message}`);
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    // Durable cursor: any event carrying a session-entry id advances it.
    const entryId = typeof event.entryId === "string" ? event.entryId : (typeof event.id === "string" ? event.id : undefined);
    if (entryId) {
      this.lastEntryId = entryId;
      this.writeSidecar({});
    }

    const mapped = mapPiEvent(event);
    if (mapped.streaming !== undefined) this.streaming = mapped.streaming;
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
    if (mapped.activity) {
      this.io.postActivity(this.activityPayload(mapped.activity.hookEvent, mapped.activity.subtype));
    }
  }

  private activityPayload(hookEvent: string, subtype: string | null): Record<string, unknown> {
    return {
      sessionName: this.identity.sessionName,
      nodeId: this.identity.nodeId ?? null,
      runtime: "pi",
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
      case "--state-root": args.stateRoot = next(); break;
      case "--cwd": args.cwd = next(); break;
      case "--launch-id": args.launchId = next(); break;
      case "--model": args.model = next(); break;
      case "--session": args.sessionFile = next(); break;
      case "--fork": args.forkRef = next(); break;
      case "--approve": args.trust = "approve"; break;
      case "--no-approve": args.trust = "no-approve"; break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!args.sessionName) throw new Error("--session-name is required");
  if (!args.stateRoot) throw new Error("--state-root is required");
  if (!args.cwd) throw new Error("--cwd is required");
  if (!args.launchId) throw new Error("--launch-id is required (launch-attempt scoping)");
  if (!args.trust) throw new Error("an explicit trust flag is required: --approve or --no-approve");
  if (args.sessionFile && args.forkRef) throw new Error("--session and --fork are mutually exclusive");
  return args as RunnerArgs;
}

function resolveActivityEndpoint(env: NodeJS.ProcessEnv): { baseUrl: string; token: string } | null {
  let baseUrl = env.OPENRIG_URL?.trim() || null;
  let token = env.OPENRIG_ACTIVITY_HOOK_TOKEN?.trim() || null;
  if (!baseUrl && env.OPENRIG_PORT) {
    baseUrl = `http://${env.OPENRIG_HOST?.trim() || "127.0.0.1"}:${env.OPENRIG_PORT.trim()}`;
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

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args: RunnerArgs;
  try {
    args = parseRunnerArgs(argv);
  } catch (err) {
    console.error(`${PI_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

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
  });
  const childArgs = buildPiChildArgs({
    sessionsDir: paths.sessionsDir,
    sessionName: args.sessionName,
    model: args.model,
    trust: args.trust,
    sessionFile: args.sessionFile,
    forkRef: args.forkRef,
  });

  console.log(`[pi-runner] starting pi --mode rpc (seat ${args.sessionName})`);
  console.log(`[pi-runner] send text normally; prefixes: "/followup <text>" queues after the turn, "/abort" cancels`);

  const child = spawn("pi", childArgs, {
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
      fetch(new URL("/api/activity/hooks", endpoint.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => { /* best-effort — never blocks the loop */ }).finally(() => clearTimeout(timeout));
    },
    writeSidecar: (state) => {
      try {
        fs.writeFileSync(paths.runnerStatePath, JSON.stringify(state));
      } catch { /* best-effort; adapter falls back to pane markers */ }
    },
    now: () => new Date().toISOString(),
  };

  const core = new RunnerCore(io, { sessionName: args.sessionName, nodeId: process.env.OPENRIG_NODE_ID, launchId: args.launchId }, { catchUpSince });
  const aggregator = new PasteAggregator((block) => core.handleUserBlock(block));

  readline.createInterface({ input: child.stdout }).on("line", (line) => core.handlePiLine(line));
  readline.createInterface({ input: child.stderr }).on("line", (line) => {
    if (line.trim()) process.stdout.write(`[pi:err] ${line}\n`);
  });
  readline.createInterface({ input: process.stdin }).on("line", (line) => aggregator.addLine(line));

  child.on("error", (err) => {
    console.error(`${PI_RUNNER_ERROR_MARKER} failed to spawn pi: ${err.message}`);
    core.handlePiExit(null);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    core.handlePiExit(code);
    process.exitCode = code ?? 1;
  });

  core.start();
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
