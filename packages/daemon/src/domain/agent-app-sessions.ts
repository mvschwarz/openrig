// Session continuity for community agent apps whose preset declares a `session` block (format 2): rendering the
// resume command, asking the app whether a session exists, listing the app's sessions, and picking the one a seat
// started. Every command runs as an argv without a shell; the only value OpenRig fills in is the session id, and only
// after it has matched the preset's id_pattern and the shell-inert floor below.
import { spawn } from "node:child_process";
import { shellQuote } from "../adapters/shell-quote.js";
import { SESSION_ID_PLACEHOLDER, type AgentAppSessionSpec } from "./agent-app-presets.js";

export { SESSION_ID_PLACEHOLDER };
/** The resume type recorded for an agent app's session id. The id means something only to the app named by the
 *  session's recorded agent app (`sessions.agent_app`), so it never resumes under another runtime. */
export const AGENT_APP_RESUME_TYPE = "agent_app_session";

// Starts with a letter or digit, so an id can never read as an option ("-c", "--help") or a path ("..").
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const LIST_TIMEOUT_MS = 60_000;
const EXISTS_TIMEOUT_MS = 60_000;
const MAX_LIST_BYTES = 1024 * 1024;

export type SessionIdCheck = { ok: true; id: string } | { ok: false; error: string };

/** A session id OpenRig will put on a command line: the shell-inert floor first, then the preset's own pattern.
 *  The error never contains the id. */
export function checkAgentAppSessionId(spec: AgentAppSessionSpec, raw: unknown): SessionIdCheck {
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, error: "the session id is empty" };
  const id = raw.trim();
  if (!SAFE_ID.test(id)) return { ok: false, error: "the session id must start with a letter or digit, hold only letters, digits, '.', '_' and '-', and be at most 200 characters" };
  if (!new RegExp(spec.idPattern).test(id)) return { ok: false, error: "the session id doesn't match the preset's id_pattern" };
  return { ok: true, id };
}

/** argv with every `{session_id}` element replaced by the id. The id must already have passed checkAgentAppSessionId. */
export function renderSessionArgv(argv: readonly string[], id: string): string[] {
  return argv.map(arg => arg === SESSION_ID_PLACEHOLDER ? id : arg);
}

/** The line typed into the seat's shell for an argv: every element single-quoted, so nothing in it is shell syntax. */
export function shellLineFor(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

export interface RunResult { code: number | null; stdout: string; timedOut: boolean; tooLarge: boolean; spawnError?: string }

/** Run an argv without a shell in `cwd`. stdout is kept only when `keepStdout`, up to MAX_LIST_BYTES; stderr is
 *  discarded. Never throws. */
export function runArgv(argv: readonly string[], cwd: string, opts: { keepStdout: boolean; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise(resolve => {
    let stdout = "";
    let bytes = 0;
    let tooLarge = false;
    let timedOut = false;
    let settled = false;
    const done = (r: RunResult) => { if (!settled) { settled = true; resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, env: opts.env ?? process.env, shell: false,
        stdio: ["ignore", opts.keepStdout ? "pipe" : "ignore", "ignore"] });
    } catch (err) {
      done({ code: null, stdout: "", timedOut: false, tooLarge: false, spawnError: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_LIST_BYTES) { tooLarge = true; child.kill("SIGKILL"); return; }
      stdout += chunk.toString("utf-8");
    });
    child.on("error", err => { clearTimeout(timer); done({ code: null, stdout: "", timedOut, tooLarge, spawnError: err.message }); });
    child.on("close", code => { clearTimeout(timer); done({ code, stdout, timedOut, tooLarge }); });
  });
}

/** Whether the app has this session: true on exit 0, false on exit 1, null for anything else (not declared,
 *  timeout, spawn failure, another exit code). */
export async function agentAppSessionExists(spec: AgentAppSessionSpec, id: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<boolean | null> {
  if (!spec.exists) return null;
  const r = await runArgv(renderSessionArgv(spec.exists, id), cwd, { keepStdout: false, timeoutMs: EXISTS_TIMEOUT_MS, env });
  if (r.timedOut || r.spawnError) return null;
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

export interface AgentAppSessionRow { id: string; created: number; directory: string | null }

/** Parse the list command's stdout: a JSON array of objects with string `id`, number `created` (epoch ms) and an
 *  optional string `directory`. Rows of any other shape are dropped; anything that isn't such an array is null. */
export function parseSessionList(stdout: string): AgentAppSessionRow[] | null {
  let doc: unknown;
  try { doc = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(doc)) return null;
  const rows: AgentAppSessionRow[] = [];
  for (const item of doc) {
    if (!item || typeof item !== "object") continue;
    const { id, created, directory } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof created !== "number" || !Number.isFinite(created)) continue;
    rows.push({ id, created, directory: typeof directory === "string" ? directory : null });
  }
  return rows;
}

/** The app's sessions, or null when the list isn't declared or couldn't be read. Runs in the seat's cwd. */
export async function listAgentAppSessions(spec: AgentAppSessionSpec, cwd: string, env?: NodeJS.ProcessEnv): Promise<AgentAppSessionRow[] | null> {
  if (!spec.list) return null;
  const r = await runArgv(spec.list, cwd, { keepStdout: true, timeoutMs: LIST_TIMEOUT_MS, env });
  if (r.timedOut || r.tooLarge || r.spawnError || r.code !== 0) return null;
  return parseSessionList(r.stdout);
}

/** The session a seat started: created at or after the seat's launch, in the seat's directory when the app reports
 *  one, not held by another seat, and passing the id checks. Exactly one such row, or null (none, or ambiguous).
 *  `cwds` holds the seat's cwd as recorded and as resolved by realpath, since an app may report either. */
export function pickSeatSession(spec: AgentAppSessionSpec, rows: readonly AgentAppSessionRow[], seat: { cwds: ReadonlySet<string>; launchedAtMs: number; heldIds: ReadonlySet<string> }): string | null {
  const candidates = rows.filter(row => row.created >= seat.launchedAtMs
    && (row.directory === null || seat.cwds.has(row.directory))
    && !seat.heldIds.has(row.id)
    && checkAgentAppSessionId(spec, row.id).ok);
  return candidates.length === 1 ? candidates[0]!.id : null;
}

/** A sessions.created_at value ("YYYY-MM-DD HH:MM:SS", UTC, from SQLite datetime('now')) as epoch ms, or null. */
export function sqliteUtcToMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}
