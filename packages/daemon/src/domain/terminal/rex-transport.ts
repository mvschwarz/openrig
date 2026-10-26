import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveOnPath } from "../../adapters/tmux-exec.js";
import { stopGroup } from "../codex-network-default.js";

/** A `rex` run that did not exit 0; `exitCode` is null when it never started or was ended. */
export class RexRunError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr = "", readonly errno?: string) {
    super(message);
    this.name = "RexRunError";
  }
}

/** One `rex` CLI run: argv (binary first) with JSON on stdin; resolves stdout, rejects with RexRunError. */
export type RexRun = (argv: string[], stdin: string, timeoutMs: number) => Promise<string>;

/** `unknown`: the request may have been applied; its reply was lost (a timeout, a killed client or an unreadable reply). */
export type RexErrorKind = "unavailable" | "method_not_found" | "failed" | "unknown";

export class RexError extends Error {
  constructor(message: string, readonly kind: RexErrorKind, readonly code?: string) {
    super(message);
    this.name = "RexError";
  }
}

export interface RexProbeResult {
  alive: boolean;
  version: string | null;
  instanceId: string | null;
  detail?: string;
}

export interface RexTransport {
  probe(): Promise<RexProbeResult>;
  request(method: string, params: unknown): Promise<Record<string, unknown>>;
}

const REQUEST_TIMEOUT_MS = 30_000;
// A healthy server answers a probe in tens of milliseconds; discovery has to fit well inside the CLI's 5 s status request.
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_SLACK_MS = 250;
const STOP_GRACE_MS = 1_000;
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `$REX_BIN_DIR/rex`, then `rex` on PATH, then the binary inside the macOS app bundle. */
export function resolveRexBinary(env: NodeJS.ProcessEnv, isExecutable: (file: string) => boolean = executable): string | null {
  const bundled = path.join(homedir(), "Library", "Application Support", "com.superlogical.rex", "RexServer", "Versions", "Current", "Rex Server.app", "Contents", "MacOS", "rex");
  const fromDir = env["REX_BIN_DIR"] ? path.join(env["REX_BIN_DIR"], "rex") : null;
  if (fromDir && isExecutable(fromDir)) return fromDir;
  return resolveOnPath("rex", env["PATH"]) ?? (isExecutable(bundled) ? bundled : null);
}

/** Runs `rex` without a shell in its own process group, ended as a group on timeout. */
export const spawnRex: RexRun = (argv, stdin, timeoutMs) => new Promise((resolve, reject) => {
  const [file, ...args] = argv;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(file!, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
  } catch (err) {
    reject(new RexRunError((err as Error).message, null, "", (err as NodeJS.ErrnoException).code));
    return;
  }
  let stdout = "";
  let stderr = "";
  let settled = false;
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk; });
  child.stderr!.on("data", (chunk: string) => { if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk; });
  child.stdin!.on("error", () => { /* rex may exit before reading its input; its exit status says why */ });
  child.stdin!.end(stdin);
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    // Past its deadline rex has nothing left to read, so end it now instead of after stopGroup's stdin grace.
    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
    void stopGroup(child, STOP_GRACE_MS).then(() => reject(new RexRunError(`did not answer within ${timeoutMs} ms`, null, stderr)));
  }, timeoutMs);
  child.once("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new RexRunError(err.message, null, stderr, (err as NodeJS.ErrnoException).code));
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code === 0) resolve(stdout);
    else reject(new RexRunError(signal ? `ended by ${signal}` : `exit ${code}`, code, stderr));
  });
});

function classify(method: string, err: unknown): RexError {
  const run = err instanceof RexRunError ? err : new RexRunError(err instanceof Error ? err.message : String(err), null);
  const said = run.stderr.trim().split("\n")[0]?.replace(/^Error:\s*/, "").replace(/^stream response "[^"]*" failed:\s*/, "") ?? "";
  const code = /\bcode=([a-z_]+)/.exec(run.stderr)?.[1];
  if (run.errno === "ENOENT" || run.exitCode === 4) return new RexError(`the Rex server is not reachable (${said || run.message})`, "unavailable", code);
  if (run.exitCode === null && !run.errno) return new RexError(`rex ${method}: ${said || run.message}`, "unknown", code);
  if (code === "method_not_found") return new RexError(`this Rex server has no ${method}; update Rex`, "method_not_found", code);
  return new RexError(`rex ${method}: ${said || run.message}`, "failed", code);
}

/**
 * The stable Rex contract: `rex --autostart=false [-S server] api call <method> -` with the params as JSON on
 * stdin. Env is read once here, as the herdr provider reads its endpoint; the binary is found on each call, so a
 * Rex installed after the daemon started is still used.
 */
export function createRexCliTransport(opts: { run?: RexRun; env?: NodeJS.ProcessEnv; binary?: () => string | null; timeoutMs?: number; probeTimeoutMs?: number } = {}): RexTransport {
  const env = { ...(opts.env ?? process.env) };
  const server = env["REX_SERVER"]?.trim();
  const run = opts.run ?? spawnRex;
  const binary = opts.binary ?? (() => resolveRexBinary(env));
  const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const request = async (method: string, params: unknown, timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> => {
    const file = binary();
    if (!file) throw new RexError("the rex command was not found in $REX_BIN_DIR, on PATH or in the Rex app", "unavailable");
    let out: string;
    try {
      out = await run([file, "--autostart=false", ...(server ? ["-S", server] : []), "api", "call", method, "-"], JSON.stringify(params ?? {}), timeoutMs);
    } catch (err) {
      throw classify(method, err);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(out); } catch { /* reported below */ }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RexError(`rex ${method} returned no JSON object`, "unknown");
    return parsed as Record<string, unknown>;
  };
  return {
    request,
    async probe() {
      const calls = [request("server.version", {}, probeTimeoutMs), request("server.status", {}, probeTimeoutMs)];
      const settled: Array<PromiseSettledResult<Record<string, unknown>> | undefined> = [];
      calls.forEach((call, i) => call.then((value) => { settled[i] = { status: "fulfilled", value }; }, (reason) => { settled[i] = { status: "rejected", reason }; }));
      // The runs end at the budget, but stopping a stuck rex can take longer; discovery answers by the budget with what came back.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, probeTimeoutMs + PROBE_SLACK_MS); });
      await Promise.race([Promise.allSettled(calls), late]);
      clearTimeout(timer);
      const [version, status] = settled;
      if (!version) return { alive: false, version: null, instanceId: null, detail: `the Rex server did not answer within ${probeTimeoutMs} ms` };
      if (version.status === "rejected") {
        return { alive: false, version: null, instanceId: null, detail: (version.reason as Error).message };
      }
      const rexVersion = version.value["rex_version"];
      const instanceId = status?.status === "fulfilled" ? status.value["instance_id"] : null;
      return {
        alive: true,
        version: typeof rexVersion === "string" && rexVersion ? rexVersion : null,
        instanceId: typeof instanceId === "string" && instanceId ? instanceId : null,
      };
    },
  };
}
