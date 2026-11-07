// The herdr-app transport: its control socket and the `hc` command, at arm's length.
//
// herdr-app (the Herdr 2 desktop app) and herdr-core are driven the way OpenRig drives tmux: a local
// socket client and a command line, never linked or embedded.
//   - App: `$HERDR_APP_HOME/herdr-app.sock`, one JSON line each way, ONE request per connection
//     (`{"status":true}`, `{"ls":true}`, `{"commands":true}`, `{"do":<cmd>,"args":{...}}`).
//   - Core: `hc <command> --json`, selected by HC_SESSION / HC_SOCKET like any `hc` call.
// Every shape here was captured from a live herdr-app 0.1.13 / hc 0.1.18 in an isolated sandbox.
//
// Outcomes are four, because the captures show a reply can't always be trusted to mean what it says:
//   ok          the reply is the result;
//   refused     a definite `{"error": ...}` from the window: nothing was done;
//   unknown     no reply, a timeout, or the socket thread's own `the window did not answer` (5 s). The
//               request may still be applied later (captures 41, 42): callers reconcile from `ls` and
//               labels, and never retry blindly;
//   unavailable the socket could not be reached, so the request was never sent.
import { execFile } from "node:child_process";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";

export type AppReply =
  | { kind: "ok"; value: unknown }
  | { kind: "refused"; error: string }
  | { kind: "unknown"; reason: string }
  | { kind: "unavailable"; reason: string };

/** The window's own reply when its main thread did not answer within 5 s (herdr-app src/control.rs). */
export const WINDOW_DID_NOT_ANSWER = "the window did not answer";

/** herdr-app's home, resolved the way herdr-app resolves it (src/mods.rs app_dir). */
export function resolveHerdrAppHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = (key: string) => env[key] ? env[key] : undefined;
  return set("HERDR_APP_HOME") ?? path.join(set("XDG_CONFIG_HOME") ?? path.join(env["HOME"] || homedir(), ".config"), "herdr-app");
}

export function herdrAppSocketPath(appHome: string): string {
  return path.join(appHome, "herdr-app.sock");
}

/** Classify one reply line. */
export function classifyAppReply(line: string | null): AppReply {
  if (line === null) return { kind: "unknown", reason: "no reply" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "unknown", reason: "unreadable reply" };
  }
  const error = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { error?: unknown }).error : undefined;
  if (typeof error === "string") return error === WINDOW_DID_NOT_ANSWER ? { kind: "unknown", reason: error } : { kind: "refused", error };
  return { kind: "ok", value: parsed };
}

/** One request, one connection, one line each way, as herdr-app's own client does. */
export type AppSocketExchange = (request: object, timeoutMs: number) => Promise<AppReply>;

export function createAppSocketExchange(socketPath: string): AppSocketExchange {
  return (request, timeoutMs) => new Promise<AppReply>((resolve) => {
    const conn = net.createConnection({ path: socketPath });
    conn.setEncoding("utf8");
    let sent = false;
    let buf = "";
    let settled = false;
    const finish = (reply: AppReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => finish(sent ? { kind: "unknown", reason: `no reply within ${timeoutMs} ms` }
      : { kind: "unavailable", reason: `herdr-app's socket did not accept a connection within ${timeoutMs} ms` }), timeoutMs);
    conn.on("connect", () => { sent = true; conn.write(`${JSON.stringify(request)}\n`); });
    conn.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) finish(classifyAppReply(buf.slice(0, nl)));
    });
    conn.on("error", (err: NodeJS.ErrnoException) => finish(sent ? { kind: "unknown", reason: err.message }
      : { kind: "unavailable", reason: `no herdr-app window at ${socketPath} (${err.code ?? err.message})` }));
    conn.on("end", () => finish(sent ? classifyAppReply(buf.trim() ? buf : null) : { kind: "unavailable", reason: "herdr-app closed the connection" }));
  });
}

export interface HcResult {
  exit: number;
  /** Parsed stdout (hc prints JSON with --json), or null. */
  json: unknown;
  stdout: string;
  /** Parsed stderr error body `{error:{kind,message,hint}}` when hc failed. */
  error?: { kind?: string; message?: string };
}

export type HcRunner = ((args: string[]) => Promise<HcResult>) & {
  core?: { session: string; socket?: string };
};

/** Clean environment for `hc`: only `HC_SESSION` and `HC_SOCKET` select a core; terminal scope markers are stripped. */
export function hcEnv(opts: { session?: string; socket?: string; env?: NodeJS.ProcessEnv } = {}): NodeJS.ProcessEnv {
  const base = opts.env ?? process.env;
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of ["HC_SCOPE", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"]) delete env[key];
  if (opts.session !== undefined) env["HC_SESSION"] = opts.session;
  if (opts.socket !== undefined) env["HC_SOCKET"] = opts.socket;
  return env;
}

/** Human-readable description of the herdr-core an `HcRunner` addresses. */
export function describeCore(hc: HcRunner): string {
  const core = hc.core;
  if (!core) return "the daemon's herdr-core";
  const session = core.session === "default" ? "the default session" : `session ${JSON.stringify(core.session)}`;
  return `herdr-core ${session}${core.socket ? ` (socket ${core.socket})` : ""}`;
}

/** `hc` with an explicit core selection. Only HC_SESSION / HC_SOCKET select a core; nothing else is passed on from a
 *  terminal. */
export function createHcRunner(opts: { bin?: string; session?: string; socket?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): HcRunner {
  const env = hcEnv(opts);
  const run: HcRunner = (args) => new Promise<HcResult>((resolve) => {
    execFile(opts.bin ?? "hc", args, { env, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const exit = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      const parse = (text: string) => { try { return JSON.parse(text.trim()); } catch { return null; } };
      const json = parse(stdout ?? "");
      const failure = exit !== 0 ? (parse(stderr ?? "") as { error?: { kind?: string; message?: string } } | null)?.error
        ?? { message: (stderr || (err as Error | null)?.message || `hc exited ${exit}`).trim() } : undefined;
      resolve({ exit, json, stdout: stdout ?? "", ...(failure ? { error: failure } : {}) });
    });
  });
  run.core = { session: env["HC_SESSION"] || "default", ...(env["HC_SOCKET"] ? { socket: env["HC_SOCKET"] } : {}) };
  return run;
}

/** The app half: typed requests over one exchange. */
export class HerdrAppClient {
  constructor(private readonly exchange: AppSocketExchange, private readonly timeoutMs = 6_000) {}

  status(timeoutMs = 1_000): Promise<AppReply> { return this.exchange({ status: true }, timeoutMs); }
  ls(): Promise<AppReply> { return this.exchange({ ls: true }, this.timeoutMs); }
  commands(timeoutMs = this.timeoutMs): Promise<AppReply> { return this.exchange({ commands: true }, timeoutMs); }
  do(command: string, args: Record<string, unknown> | null = null): Promise<AppReply> {
    return this.exchange({ do: command, args }, this.timeoutMs);
  }
}
