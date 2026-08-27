import path from "node:path";
import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { ConfigStore } from "./config-store.js";
import { OPENRIG_HOME, LEGACY_RIGGED_HOME, readOpenRigEnv } from "./openrig-compat.js";
import { workspaceScaffoldDirs, workspaceScaffoldFiles } from "./commands/config-init-workspace.js";

export interface DaemonState {
  pid: number;
  port: number;
  host?: string;
  db: string;
  startedAt: string;
}

/**
 * OPR.0.4.3.21 — event-loop wedge evidence read from the enriched `/healthz`
 * body. Present only when the daemon actually answered healthz with a monitor
 * wired; absent when healthz timed out (a wedged loop can't respond — the
 * evidence in that case is `reason: "unresponsive"`).
 */
export interface DaemonEventLoopEvidence {
  lagMeanMs: number;
  lagP99Ms: number;
  utilization: number;
  lastTickAgeMs: number;
  healthy: boolean;
}

export interface DaemonStatus {
  /** RULING 1ae863d2 — C3 3-state semantics (canonical: daemon crash-cart-detect.ts, kept in
   *  lockstep): "stopped" requires POSITIVE evidence (connection refused); a probe TIMEOUT or
   *  other non-refusal failure is "unverified" — never a down assertion. */
  state: "running" | "stopped" | "stale" | "unverified";
  /** Home-resolution honesty: set when the resolved home lacks daemon state but a live sibling
   *  home (or a HOME-MOVED marker) exists — callers name BOTH paths, never assert down. */
  siblingHint?: { resolvedHome: string; siblingHome: string };
  port?: number;
  host?: string;
  pid?: number;
  healthy?: boolean;
  /**
   * OPR.0.4.3.21 — why an alive+listening daemon is unhealthy. "unresponsive"
   * = the process is up but `/healthz` timed out (the honest wedged-loop
   * signal); "event-loop-starved" = healthz answered but the loop-lag /
   * last-tick evidence crossed the threshold. Absent when healthy.
   */
  reason?: "unresponsive" | "event-loop-starved";
  /** OPR.0.4.3.21 — event-loop evidence when healthz answered with a monitor. */
  eventLoop?: DaemonEventLoopEvidence;
}

/** Build the daemon HTTP URL from status. Uses persisted host or defaults to 127.0.0.1. */
export function getDaemonUrl(status: DaemonStatus): string {
  return `http://${status.host ?? DEFAULT_HOST}:${status.port}`;
}

/**
 * OPR.0.3.3.04.2 (AC-4): the ONE shared honest daemon-not-running error for the
 * daemon-dependent journey verbs (bootstrap / discover / workspace / workflow).
 * Mirrors the repo's 3-part fact / consequence / action convention
 * (commands/archive.ts, commands/queue.ts) so the daemon-dependency UX is
 * consistent across the new-operator journey instead of four divergent bare
 * dead-ends. Bounded to the daemon-not-running path - NOT a general
 * error-framework (that would be its own slice).
 */
export interface DaemonNotRunningError {
  fact: string;
  consequence: string;
  action: string;
}

export function daemonNotRunningError(): DaemonNotRunningError {
  return {
    fact: "Daemon not running.",
    consequence: "This command needs a running daemon.",
    action: "Run 'rig up' (it auto-starts the daemon), or 'rig daemon start'.",
  };
}

/**
 * Print the shared daemon-not-running error and set a failing exit code. Pass
 * `{ json: true }` for the agent-facing `{ error: { fact, consequence, action } }`
 * envelope (matching commands/queue.ts JSON output).
 */

/** B8-1b (shape 73ee4b25) — the epistemic-matched guard message: language derives from
 *  what the probe KNOWS. UNVERIFIED/unhealthy = "did not respond" (down ≠ busy);
 *  stopped/stale = the plain not-running truth. Pure so every surface shares it. */
export function statusGuardMessage(status: DaemonStatus): DaemonNotRunningError {
  if (status.state === "stopped" || status.state === "stale") {
    return daemonNotRunningError();
  }
  // unverified, or running-but-unhealthy: we do NOT know it is down.
  return {
    fact: "Daemon did not respond — it may be busy or stopped (state not confirmed).",
    consequence: "This command needs a responsive daemon; the outcome of proceeding would be indeterminate.",
    action: "Re-check with 'rig daemon status'. If it is confirmed stopped, run 'rig up' or 'rig daemon start'.",
  };
}

/** B8-1b — THE precheck chokepoint: returns true when the daemon is running+healthy;
 *  otherwise prints the epistemic-matched 3-part (+ the wrong-home sibling hint when
 *  present), sets exit 1, returns false. Replaces the ~55 hand-rolled verbatim guards. */
export function daemonStatusGuard(status: DaemonStatus, opts?: { json?: boolean }): boolean {
  if (status.state === "running" && status.healthy !== false) return true;
  const err = statusGuardMessage(status);
  if (opts?.json) {
    console.log(JSON.stringify({ error: err }));
  } else {
    console.error(`Error: ${err.fact}`);
    console.error(`  ${err.consequence}`);
    console.error(`  ${err.action}`);
  }
  if (status.siblingHint) {
    console.error(`  note: OPENRIG_HOME may be wrong — resolved ${status.siblingHint.resolvedHome}, live sibling ${status.siblingHint.siblingHome}`);
  }
  process.exitCode = 1;
  return false;
}

export function printDaemonNotRunning(opts?: { json?: boolean }): void {
  const err = daemonNotRunningError();
  if (opts?.json) {
    console.log(JSON.stringify({ error: err }));
  } else {
    console.error(`Error: ${err.fact}`);
    console.error(`  ${err.consequence}`);
    console.error(`  ${err.action}`);
  }
  process.exitCode = 1;
}

export interface StartOptions {
  port?: number;
  host?: string;
  db?: string;
  transcriptsEnabled?: boolean;
  transcriptsPath?: string;
  /** When set, daemon startup idempotently ensures the default workspace exists. */
  workspaceRoot?: string;
  // V1 pre-release CLI/daemon Item 1 — capture-pane rotation tunables.
  // Threaded through to the daemon process env so the rotation hook
  // picks up file-stored ConfigStore values, not just shell env.
  transcriptsLines?: number;
  transcriptsPollIntervalSeconds?: number;
  // V0.3.1 slice 05 kernel-rig-as-default — when true, daemon startup
  // skips the kernel auto-boot path (kernel rig is not materialized).
  // Exposed at the CLI as `rig daemon start --no-kernel`; projected
  // into the daemon process env as OPENRIG_NO_KERNEL.
  skipKernelBoot?: boolean;
}

export interface LifecycleDeps {
  spawn: (cmd: string, args: string[], opts: {
    env: Record<string, string>;
    stdio: unknown;
    detached: boolean;
  }) => ChildProcess;
  // OPR.0.4.3.21 — optional `json` lets getDaemonStatus read the enriched
  // /healthz body (event-loop evidence). Optional so existing mocks that
  // return `{ ok }` are unchanged; production (realDeps) supplies it.
  fetch: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>;
  kill: (pid: number, signal: string) => boolean;
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  removeFile: (path: string) => void;
  exists: (path: string) => boolean;
  mkdirp: (path: string) => void;
  openForAppend: (path: string) => number;
  isProcessAlive: (pid: number) => boolean;
  // OPR.0.4.2.1 — optional injectable delay for the status-probe bounded settle/retry.
  // Defaults to a real setTimeout in production; tests pass a no-op to stay fast. Optional so
  // existing deps / mocks / callers are untouched.
  sleep?: (ms: number) => Promise<void>;
  // RULING 1ae863d2 — optional home-resolution honesty deps (optional so existing
  // mocks/callers are untouched): homeDir overrides the module-load OPENRIG_DIR for
  // the sibling-home scan; listDir lists a directory (production: fs.readdirSync).
  homeDir?: string;
  listDir?: (path: string) => string[];
}

export const OPENRIG_DIR = OPENRIG_HOME;
export const RIGGED_DIR = OPENRIG_DIR;
export const STATE_FILE = path.join(OPENRIG_DIR, "daemon.json");
export const LOG_FILE = path.join(OPENRIG_DIR, "daemon.log");
export const LEGACY_STATE_FILE = path.join(LEGACY_RIGGED_HOME, "daemon.json");
export const LEGACY_LOG_FILE = path.join(LEGACY_RIGGED_HOME, "daemon.log");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7433;
const DEFAULT_DB = "openrig.sqlite";
// Fresh Linux hosts can take longer than a warmed dev machine to load native
// modules, run startup reconciliation, and bind healthz. Keep the retry loop
// bounded, but do not kill a healthy daemon during first-boot slack.
const HEALTHZ_RETRIES = 80;
const HEALTHZ_DELAY_MS = 250;
// OPR.0.4.7 slice-05 item-4: the WHOLE status health probe stays within ONE normal
// CLI request window (~5s, matching DaemonClient's timeoutMs) — immediate connection
// errors may retry INSIDE this deadline, but it is NEVER re-allocated per retry. So a
// slow-but-answering /healthz (e.g. 400ms) is OBSERVED rather than falsely reported
// stopped; a genuine connection refusal still fails within the window -> stopped.
const STATUS_PROBE_DEADLINE_MS = 5000;
// OPR.0.4.2.1 — status-probe bounded settle: a single /healthz fetch loses to the post-restart
// listener bind window (process up, not yet accepting). getDaemonStatus retries a HARD-BOUNDED
// number of attempts with a short backoff so the status reflects the ACTUAL /healthz answer. This
// is status-probe-LOCAL (does NOT change start/stop/checkPid timing). Worst-case added latency for
// a genuine-down status check is bounded ((ATTEMPTS-1)*DELAY + per-attempt timeout) — never a hang.
const STATUS_PROBE_MAX_ATTEMPTS = 5;
const STATUS_PROBE_RETRY_DELAY_MS = 200;
// Per-probe /healthz timeout for the SINGLE-SHOT callers that are NOT the status
// settle path — checkPid classification and the start/stop recovery guards, plus
// each iteration of startDaemon's own HEALTHZ_RETRIES poll loop. These keep their
// prior fixed-bound timing (the settle deadline above is status-probe-LOCAL); this
// restores the timeout the removed HEALTHZ_PROBE_TIMEOUT_MS supplied to them.
const HEALTHZ_PROBE_TIMEOUT_MS = 250;

export interface WorkspaceScaffoldResult {
  root: string;
  rootCreated: boolean;
  subdirs: Array<{ name: string; path: string; created: boolean }>;
  files: Array<{ relPath: string; absPath: string; created: boolean; skipped: "exists" | null }>;
}

export function ensureWorkspaceScaffold(root: string, deps: LifecycleDeps): WorkspaceScaffoldResult {
  const rootExists = deps.exists(root);
  if (!rootExists) deps.mkdirp(root);

  const result: WorkspaceScaffoldResult = {
    root,
    rootCreated: !rootExists,
    subdirs: [],
    files: [],
  };

  for (const sub of workspaceScaffoldDirs()) {
    const subPath = path.join(root, sub);
    const existed = deps.exists(subPath);
    if (!existed) deps.mkdirp(subPath);
    result.subdirs.push({ name: sub, path: subPath, created: !existed });
  }

  for (const file of workspaceScaffoldFiles()) {
    const absPath = path.join(root, file.relPath);
    const existed = deps.exists(absPath);
    if (existed) {
      result.files.push({ relPath: file.relPath, absPath, created: false, skipped: "exists" });
      continue;
    }
    deps.writeFile(absPath, file.content);
    result.files.push({ relPath: file.relPath, absPath, created: true, skipped: null });
  }

  return result;
}

class HealthProbeTimeoutError extends Error {
  constructor(url: string) {
    super(`healthz probe timed out for ${url}`);
    this.name = "HealthProbeTimeoutError";
  }
}

function summarizeDaemonStartFailure(healthzUrl: string, logContent: string | null): string {
  const generic = `Daemon failed to start: healthz at ${healthzUrl} not responding`;
  const lines = (logContent ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return generic;

  const recentLines = lines.slice(-20);
  const recentBlock = recentLines.join("\n");

  if (/ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(recentBlock)) {
    const moduleName = /better[-_]?sqlite3/i.test(recentBlock) ? "better-sqlite3" : "the daemon's native module";
    const detail = recentLines.find((line) => /ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(line))
      ?? recentLines[recentLines.length - 1]!;
    return [
      `Daemon failed to start under Node ${process.version} (${process.execPath}).`,
      `${moduleName} could not load because its native binary does not match the active Node runtime.`,
      `Recent daemon log: ${detail}`,
      "Fix: switch back to the Node version used when @openrig/cli was installed, or reinstall @openrig/cli under the current node, then retry `rig daemon start`.",
    ].join(" ");
  }

  const detail = [...recentLines].reverse().find((line) => /error|ERR_|failed|exception|cannot|disk full/i.test(line))
    ?? recentLines[recentLines.length - 1]!;
  return `${generic}. Recent daemon log: ${detail}`;
}

export function resolveCliBaseDir(baseDir: string): string {
  return path.basename(baseDir) === "commands" ? path.resolve(baseDir, "..") : baseDir;
}

/**
 * Pure resolver: prefers monorepo source when present (dev checkout
 * where `packages/daemon/dist` is the source of truth), falls back to
 * the bundled/vendored copy at `packages/cli/daemon` (the npm-install
 * layout).
 *
 * Why this order: in a monorepo dev checkout BOTH paths exist:
 *   - packages/daemon/dist                ← refreshed by
 *                                            `npm run build --workspace
 *                                            @openrig/daemon` (frequent;
 *                                            source of truth)
 *   - packages/cli/daemon/dist            ← refreshed only by
 *                                            `scripts/build-package.sh`
 *                                            (rare; for npm publish)
 *
 * Picking the vendored copy first (the prior order) means devs run a
 * stale daemon through `rig daemon start` whenever they've rebuilt
 * `@openrig/daemon` but haven't rerun `build-package.sh`. That hid the
 * fact that QA on local main 55e01f2e was getting a daemon WITHOUT the
 * shipped slice-09 `/api/rig-mode/*` routes (qitem-20260518054224).
 *
 * In an npm-install layout `packages/daemon/dist` does not exist
 * (only the bundled `packages/cli/daemon` lives next to the cli);
 * the fallback handles that case unchanged.
 */
export function resolveDaemonPath(baseDir: string, exists: (p: string) => boolean): string {
  const cliBaseDir = resolveCliBaseDir(baseDir);
  const monorepo = path.resolve(cliBaseDir, "../../daemon");
  if (exists(path.join(monorepo, "dist/index.js"))) return monorepo;
  const bundled = path.resolve(cliBaseDir, "../daemon");
  if (exists(path.join(bundled, "dist/index.js"))) return bundled;
  // Last-resort: return the monorepo path so callers get a meaningful
  // error rather than crashing on undefined. The caller validates
  // existence elsewhere (doctor / start) and surfaces "daemon dist not
  // found at <path>".
  return monorepo;
}

export function getDaemonPath(): string {
  return resolveDaemonPath(import.meta.dirname, existsSync);
}

function readState(deps: LifecycleDeps): DaemonState | null {
  const stateFile = resolveLifecycleFile(deps, "daemon.json");
  if (!deps.exists(stateFile)) return null;
  const raw = deps.readFile(stateFile);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DaemonState;
  } catch {
    // Malformed daemon.json — treat as no state
    console.error("Warning: malformed daemon.json, treating as stopped");
    return null;
  }
}

function resolveLifecycleFile(deps: LifecycleDeps, filename: "daemon.json" | "daemon.log"): string {
  const primary = filename === "daemon.json" ? STATE_FILE : LOG_FILE;
  if (deps.exists(primary)) return primary;

  const legacy = filename === "daemon.json" ? LEGACY_STATE_FILE : LEGACY_LOG_FILE;
  if (deps.exists(legacy)) return legacy;

  return primary;
}

/** Check if a PID is an OpenRig daemon. Returns:
 *  - "openrig" — healthz responded (ok or not) → this is our daemon
 *  - "not_openrig" — connection refused → PID is alive but not listening on our port
 *  - "unresponsive" — pid is alive but healthz probe timed out
 *  - "dead" — PID not alive */
async function checkPid(state: DaemonState, deps: LifecycleDeps): Promise<"openrig" | "not_openrig" | "unresponsive" | "dead"> {
  if (!deps.isProcessAlive(state.pid)) return "dead";
  const host = state.host ?? DEFAULT_HOST;
  try {
    await fetchDaemonProbe(deps, `http://${host}:${state.port}/healthz`, HEALTHZ_PROBE_TIMEOUT_MS);
    // Any response (ok or not) means something is listening on our port → OpenRig
    return "openrig";
  } catch (err) {
    if (err instanceof HealthProbeTimeoutError) return "unresponsive";
    // Connection refused → PID alive but not our daemon
    return "not_openrig";
  }
}

function resolveConfiguredDaemonTarget(): { host: string; port: number } {
  try {
    const config = new ConfigStore().resolve();
    return {
      host: config.daemon.host,
      port: config.daemon.port,
    };
  } catch {
    return {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
    };
  }
}

/**
 * Scrub list: environment variable prefixes and exact names that should NOT
 * be forwarded from the operator shell into the daemon process. These are
 * terminal-emulator, GUI-session, and cmux-session variables that can break
 * adapter initialization when the daemon runs detached.
 */
const ENV_SCRUB_PREFIXES = ["CODEX_", "GHOSTTY_", "XPC_", "__CF"];
// S20 (OPR.0.5.5.20) — the ROUTING-OVERLOADED vars: client/endpoint state a managed
// environment may inject, byte-indistinguishable from operator opt-in. They are ALWAYS
// scrubbed from the daemon env; bind intent crosses ONLY via the dedicated
// OPENRIG_BIND_HOST (exported below when opts.host declares it). THE RULE FOR FUTURE
// PASSTHROUGH EDITS: any env var that doubles as client routing state must join this
// set — routing state silently becoming bind policy is the incident class
// (operator baton qitem-20260827070400: parent lost its Tailscale listener).
const ROUTING_ENV_SCRUB = new Set(["OPENRIG_HOST", "RIGGED_HOST"]);

const ENV_SCRUB_EXACT = new Set([
  "CMUX_SOCKET_PATH",
  "CMUX_SURFACE_ID",
  "CMUX_WORKSPACE",
  "COLORTERM",
  "COMMAND_MODE",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERMINFO",
]);

export function buildDaemonEnv(
  baseEnv: Record<string, string>,
  opts: {
    port: number;
    /**
     * Operator-explicit bind host. When undefined the CLI is signaling
     * "no operator opt-in" so the daemon's index.ts can fall through to
     * the default loopback+tailscale-auto multi-bind path (bug-fix slice
     * auth-bearer-tailscale-trust). When defined, the daemon takes the
     * explicit-host branch and applies the bearer invariant to it.
     * S20: when undefined, NO env fallback exists — inherited
     * OPENRIG_HOST/RIGGED_HOST are ROUTING state and are scrubbed by
     * ROUTING_ENV_SCRUB (the shell-level-opt-in premise died: injected
     * routing env is byte-indistinguishable from opt-in). The dedicated
     * OPENRIG_BIND_HOST is the only env opt-in and passes through.
     */
    host?: string;
    db: string;
    transcriptsEnabled?: boolean;
    transcriptsPath?: string;
    // V1 pre-release CLI/daemon Item 1 — projected from ConfigStore so
    // the rotation hook honors file-stored values, not just inherited
    // shell env.
    transcriptsLines?: number;
    transcriptsPollIntervalSeconds?: number;
    // V0.3.1 slice 05 — projected via OPENRIG_NO_KERNEL env var so
    // the daemon's startup.ts kernel-boot path honors the flag.
    skipKernelBoot?: boolean;
  },
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (ENV_SCRUB_EXACT.has(key)) continue;
    if (ROUTING_ENV_SCRUB.has(key)) continue; // S20: routing env never crosses (see the set's contract)
    // CODEX_HOME is daemon topology/config-root state. Every other CODEX_*
    // value remains transient runtime/auth/session state and stays scrubbed.
    if (key !== "CODEX_HOME" && ENV_SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }

  // Explicit OPENRIG_* overrides — always win over inherited values
  env["OPENRIG_PORT"] = String(opts.port);
  if (opts.host !== undefined) {
    // S20 — DECLARED intent exports the dedicated bind surface plus a COHERENT routing
    // value (seats/consumers route where the daemon actually binds).
    env["OPENRIG_BIND_HOST"] = opts.host;
    env["OPENRIG_HOST"] = opts.host;
  }
  env["OPENRIG_DB"] = opts.db;
  if (opts.transcriptsEnabled !== undefined) {
    env["OPENRIG_TRANSCRIPTS_ENABLED"] = String(opts.transcriptsEnabled);
  }
  if (opts.transcriptsPath) {
    env["OPENRIG_TRANSCRIPTS_PATH"] = opts.transcriptsPath;
  }
  if (opts.transcriptsLines !== undefined) {
    env["OPENRIG_TRANSCRIPTS_LINES"] = String(opts.transcriptsLines);
  }
  if (opts.transcriptsPollIntervalSeconds !== undefined) {
    env["OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS"] = String(opts.transcriptsPollIntervalSeconds);
  }
  if (opts.skipKernelBoot) {
    env["OPENRIG_NO_KERNEL"] = "1";
  }

  return env;
}

// ── OPR.0.5.5.20 — bind-intent provenance + the listener adoption gate (S20 RED: unwired) ──

/** Resolve OPERATOR BIND INTENT from the dedicated surfaces ONLY: the --host flag, the
 *  daemon.host config key read from the FILE, or the dedicated OPENRIG_BIND_HOST env.
 *  A daemon.host value resolved from ENV is the overloaded routing channel
 *  (ENV_MAP maps daemon.host ← OPENRIG_HOST) and NEVER creates intent. */
export function resolveBindIntent(input: {
  flagHost: string | undefined;
  envBindHost: string | undefined;
  configSource: string;
  configHost: string;
}): { explicit: boolean; host: string | undefined } {
  if (input.flagHost !== undefined) return { explicit: true, host: input.flagHost };
  const envBind = input.envBindHost?.trim() || undefined;
  if (envBind) return { explicit: true, host: envBind };
  if (input.configSource === "file") return { explicit: true, host: input.configHost };
  // "env"-sourced daemon.host is the overloaded routing channel — never intent;
  // "default" is no declaration at all.
  return { explicit: false, host: undefined };
}

/** The restored adoption/upgrade gate: derive the REQUIRED listener set from the
 *  daemon's reported effective bind mode (default ⇒ loopback AND
 *  tailscale-when-detected; explicit ⇒ exactly the declared host) and prove each by
 *  probing its own /healthz — binding evidence, never config echo. A silently dropped
 *  listener (the 0.5.3-receipt regression shape) fails LOUDLY. */
export async function verifyRequiredListeners(input: {
  bind: { mode: "explicit" | "default"; hosts: string[]; tailscaleDetected: boolean };
  port: number;
  /** TRI-STATE probe (r2 repair): "healthy" | "unhealthy" | "indeterminate".
   *  Refused/explicitly-unhealthy is POSITIVE bad-bind evidence; a transient probe
   *  exception is INDETERMINATE and never becomes missing-listener evidence. */
  probe: (url: string) => Promise<"healthy" | "unhealthy" | "indeterminate">;
}): Promise<
  | { ok: true; verified: string[] }
  | { ok: false; missing: string[]; reason: string }
  | { ok: "indeterminate"; reason: string }
> {
  const required = new Set(input.bind.hosts);
  required.add("127.0.0.1"); // loopback is required in EVERY mode's floor... except explicit
  if (input.bind.mode === "explicit") {
    required.clear();
    for (const h of input.bind.hosts) required.add(h);
  } else if (input.bind.tailscaleDetected && input.bind.hosts.length < 2) {
    // The 0.5.3-receipt regression shape: default mode, tailscale present, but the
    // daemon reports only one listener — the tailscale listener was silently dropped.
    return {
      ok: false,
      missing: ["<tailscale interface>"],
      reason:
        `required listener missing: default bind mode with a tailscale interface detected must bind loopback AND tailscale, but the daemon reports only [${input.bind.hosts.join(", ")}] — a silently dropped listener (the 0.5.3 receipt regression shape).`,
    };
  }
  const missing: string[] = [];
  const verified: string[] = [];
  const indeterminate: string[] = [];
  for (const host of required) {
    // NO catch-collapse here (r2 finding): the probe classifies its own errors; an
    // exception reaching this point is a wiring bug and should surface, not convert.
    const outcome = await input.probe(`http://${host}:${input.port}/healthz`);
    if (outcome === "healthy") verified.push(host);
    else if (outcome === "unhealthy") missing.push(host);
    else indeterminate.push(host);
  }
  if (indeterminate.length > 0) {
    // Indeterminate beats missing in precedence: with ANY listener unverifiable, the
    // gate has no complete evidence set and must not authorize a kill.
    return {
      ok: "indeterminate",
      reason: `listener state could not be checked for ${indeterminate.join(", ")} (transient probe failure) — the gate acts only on positive evidence and takes no action.`,
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason: `required listener(s) not answering /healthz: ${missing.join(", ")} — binding evidence beats config echo; a reported host must prove itself.`,
    };
  }
  return { ok: true, verified };
}

export async function startDaemon(opts: StartOptions, deps: LifecycleDeps): Promise<DaemonState> {
  const port = opts.port ?? DEFAULT_PORT;
  const db = opts.db ?? DEFAULT_DB;
  // bug-fix slice auth-bearer-tailscale-trust: preserve the
  // user-explicit-vs-default distinction. `opts.host` is undefined when
  // the operator never opted in; in that case healthz probes still use
  // the loopback default, but buildDaemonEnv must NOT export
  // OPENRIG_HOST so the daemon falls through to the multi-bind default
  // (loopback + tailscale auto-detect).
  const explicitHost = opts.host;
  const probeHost = explicitHost ?? DEFAULT_HOST;

  // Check if already running
  const existing = readState(deps);
  if (existing) {
    const pidState = await checkPid(existing, deps);
    if (pidState === "openrig") {
      // Our daemon is running (possibly unhealthy, but alive on our port)
      throw new Error(`Daemon already running (pid ${existing.pid} on port ${existing.port})`);
    }
    if (pidState === "unresponsive") {
      throw new Error(`Existing daemon process (pid ${existing.pid} on port ${existing.port}) is unresponsive — recover it before starting a new daemon.`);
    }
    // "dead" or "not_rigged" → stale state, safe to proceed
  } else {
    let recoveredRunning = false;
    try {
      await fetchDaemonProbe(deps, `http://${probeHost}:${port}/healthz`, HEALTHZ_PROBE_TIMEOUT_MS);
      recoveredRunning = true;
    } catch (err) {
      if (err instanceof HealthProbeTimeoutError) {
        throw new Error(`Daemon on port ${port} is unresponsive, and daemon state is missing — recover it before starting a new daemon.`);
      }
    }
    if (recoveredRunning) {
      throw new Error(`Daemon already running on port ${port}, but daemon state is missing`);
    }
  }
  const daemonEntry = path.join(getDaemonPath(), "dist/index.js");

  deps.mkdirp(OPENRIG_DIR);
  if (opts.workspaceRoot) {
    ensureWorkspaceScaffold(opts.workspaceRoot, deps);
  }

  const logFd = deps.openForAppend(LOG_FILE);

  const child = deps.spawn(process.execPath, [daemonEntry], {
    env: buildDaemonEnv(process.env as Record<string, string>, {
      port,
      host: explicitHost,
      db,
      transcriptsEnabled: opts.transcriptsEnabled,
      transcriptsPath: opts.transcriptsPath,
      transcriptsLines: opts.transcriptsLines,
      transcriptsPollIntervalSeconds: opts.transcriptsPollIntervalSeconds,
      skipKernelBoot: opts.skipKernelBoot,
    }),
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });

  child.unref();

  const pid = child.pid!;

  // Poll healthz against the configured probe host (loopback default
  // when operator didn't opt in to a specific bind).
  const healthzUrl = `http://${probeHost}:${port}/healthz`;
  let healthy = false;
  for (let i = 0; i < HEALTHZ_RETRIES; i++) {
    try {
      const res = await fetchDaemonProbe(deps, healthzUrl, HEALTHZ_PROBE_TIMEOUT_MS);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTHZ_DELAY_MS));
  }

  if (!healthy) {
    try { deps.kill(pid, "SIGTERM"); } catch { /* best effort */ }
    const logContent = deps.readFile(resolveLifecycleFile(deps, "daemon.log"));
    throw new Error(summarizeDaemonStartFailure(healthzUrl, logContent));
  }

  // S20 — the restored adoption/upgrade gate: when the daemon reports its bind plan,
  // derive the required listener set from the EFFECTIVE mode and prove every listener
  // by probing its own /healthz. A silently dropped listener fails the start LOUDLY
  // (the 0.5.3-receipt regression accepted loopback health alone and missed exactly
  // this). Older daemons without the payload skip the gate unchanged (additive).
  try {
    const healthRes = await fetchDaemonProbe(deps, healthzUrl, HEALTHZ_PROBE_TIMEOUT_MS);
    const healthBody = (await (healthRes.json?.() ?? Promise.resolve(null)).catch(() => null)) as
      | { bind?: { mode: "explicit" | "default"; hosts: string[]; tailscaleDetected: boolean } }
      | null;
    if (healthBody?.bind) {
      const gate = await verifyRequiredListeners({
        bind: healthBody.bind,
        port,
        // r2 repair — error PROVENANCE preserved: an explicit non-OK answer or a
        // connection refusal is positive evidence ("unhealthy"); a timeout or any
        // other transient probe exception is "indeterminate" and can never kill.
        probe: async (url) => {
          try {
            const r = await fetchDaemonProbe(deps, url, HEALTHZ_PROBE_TIMEOUT_MS);
            return r.ok ? "healthy" : "unhealthy";
          } catch (err) {
            const code = (err as { code?: string; cause?: { code?: string } }).code
              ?? (err as { cause?: { code?: string } }).cause?.code;
            return code === "ECONNREFUSED" ? "unhealthy" : "indeterminate";
          }
        },
      });
      if (gate.ok === false) {
        try { deps.kill(pid, "SIGTERM"); } catch { /* best effort */ }
        throw new Error(`daemon started but FAILED the listener adoption gate: ${gate.reason}`);
      }
      // gate.ok === "indeterminate" falls through healthy: no evidence, no action.
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("listener adoption gate")) throw err;
    // A parse/probe hiccup on the gate read must not kill an otherwise healthy start;
    // the gate acts only on POSITIVE evidence of a bad bind (never on its own failure).
  }

  const state: DaemonState = {
    pid,
    port,
    // Persist the probe host (operator-explicit when set, loopback
    // default otherwise) so subsequent status reads can reach the
    // daemon regardless of whether tailscale was added at multi-bind.
    host: probeHost,
    db,
    startedAt: new Date().toISOString(),
  };

  deps.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

export async function stopDaemon(deps: LifecycleDeps): Promise<void> {
  const state = readState(deps);
  if (!state) {
    const configured = resolveConfiguredDaemonTarget();
    let recoveredRunning = false;
    try {
      await fetchDaemonProbe(deps, `http://${configured.host}:${configured.port}/healthz`, HEALTHZ_PROBE_TIMEOUT_MS);
      recoveredRunning = true;
    } catch (err) {
      if (err instanceof HealthProbeTimeoutError) {
        throw new Error(`Daemon state is missing and port ${configured.port} is unresponsive — cannot stop safely.`);
      }
    }
    if (recoveredRunning) {
      throw new Error(`Daemon is running on port ${configured.port}, but daemon state is missing — cannot stop safely.`);
    }
    return;
  }
  const stateFile = resolveLifecycleFile(deps, "daemon.json");

  const pidState = await checkPid(state, deps);
  if (pidState === "dead") {
    // Already dead — clean up stale state
    deps.removeFile(stateFile);
    return;
  }
  if (pidState === "not_openrig") {
    // PID alive but not our daemon (reused PID) — clean up state, don't kill
    deps.removeFile(stateFile);
    return;
  }

  // pidState === "openrig" or "unresponsive" — safe to SIGTERM
  deps.kill(state.pid, "SIGTERM");

  // Wait briefly for process to exit
  let exited = false;
  for (let i = 0; i < 20; i++) {
    if (!deps.isProcessAlive(state.pid)) {
      exited = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (exited) {
    deps.removeFile(stateFile);
  } else {
    throw new Error(`Daemon (pid ${state.pid}) did not exit after SIGTERM — state file preserved`);
  }
}

/** RULING 1ae863d2 — positive-down evidence classifier (lockstep with the daemon's
 *  crash-cart-detect semantics): ONLY a connection refusal is strong down evidence;
 *  a timeout / abort / anything else never proves the daemon dead. */
function isRefusedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  const code = (err as Error & { code?: string }).code;
  return cause?.code === "ECONNREFUSED" || code === "ECONNREFUSED" || /refused/i.test(err.message);
}

/** RULING 1ae863d2 — best-effort wrong-home detection: a HOME-MOVED marker in the resolved
 *  home, else a live sibling `.openrig*` home (daemon.json with an alive pid) beside it.
 *  Never throws — a failed scan just yields no hint. */
function findSiblingHome(deps: LifecycleDeps): DaemonStatus["siblingHint"] {
  try {
    const home = deps.homeDir ?? OPENRIG_DIR;
    const marker = path.join(home, "HOME-MOVED");
    if (deps.exists(marker)) {
      const target = deps.readFile(marker)?.trim();
      if (target) return { resolvedHome: home, siblingHome: target };
    }
    if (!deps.listDir) return undefined;
    const parent = path.dirname(home);
    const self = path.basename(home);
    for (const entry of deps.listDir(parent)) {
      if (!entry.startsWith(".openrig") || entry === self) continue;
      const sibling = path.join(parent, entry);
      const stateFile = path.join(sibling, "daemon.json");
      if (!deps.exists(stateFile)) continue;
      const raw = deps.readFile(stateFile);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { pid?: number };
        if (typeof parsed.pid === "number" && deps.isProcessAlive(parsed.pid)) {
          return { resolvedHome: home, siblingHome: sibling };
        }
      } catch {
        continue;
      }
    }
  } catch {
    // best-effort only
  }
  return undefined;
}

export async function getDaemonStatus(deps: LifecycleDeps): Promise<DaemonStatus> {
  // If OPENRIG_URL is set, bypass daemon.json and probe that URL directly
  const openrigUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
  if (openrigUrl) {
    try {
      const res = await probeHealthzWithSettle(deps, `${openrigUrl}/healthz`);
      const ev = await readHealthEvidence(res);
      const url = new URL(openrigUrl);
      return { state: "running", port: Number(url.port) || DEFAULT_PORT, host: url.hostname || DEFAULT_HOST, healthy: ev.healthy, reason: ev.reason, eventLoop: ev.eventLoop };
    } catch (err) {
      // 1ae863d2: refusal = positive down; anything else (timeout/wedged) = unverified.
      return isRefusedError(err) ? { state: "stopped" } : { state: "unverified" };
    }
  }

  const state = readState(deps);
  if (!state) {
    const configured = resolveConfiguredDaemonTarget();
    try {
      const res = await probeHealthzWithSettle(deps, `http://${configured.host}:${configured.port}/healthz`);
      const ev = await readHealthEvidence(res);
      return {
        state: "running",
        port: configured.port,
        host: configured.host,
        healthy: ev.healthy,
        reason: ev.reason,
        eventLoop: ev.eventLoop,
      };
    } catch (err) {
      // 1ae863d2: the resolved home has NO daemon state — before asserting anything,
      // look for a live sibling home / HOME-MOVED marker (the wrong-home class).
      const siblingHint = findSiblingHome(deps);
      if (siblingHint) return { state: "unverified", siblingHint };
      return isRefusedError(err) ? { state: "stopped" } : { state: "unverified" };
    }
  }

  if (!deps.isProcessAlive(state.pid)) {
    // Process dead — stale state
    deps.removeFile(resolveLifecycleFile(deps, "daemon.json"));
    return { state: "stale" };
  }

  // Process alive — check healthz
  const host = state.host ?? DEFAULT_HOST;
  let healthy = false;
  let reason: DaemonStatus["reason"];
  let eventLoop: DaemonEventLoopEvidence | undefined;
  try {
    const res = await probeHealthzWithSettle(deps, `http://${host}:${state.port}/healthz`);
    const ev = await readHealthEvidence(res);
    healthy = ev.healthy;
    reason = ev.reason;
    eventLoop = ev.eventLoop;
  } catch {
    // OPR.0.4.3.21 — pid alive but healthz timed out: the honest wedged-loop
    // signal. Report process-present/unhealthy (NOT "stopped") with the
    // "unresponsive" reason so the operator knows it's the control plane.
    reason = "unresponsive";
  }

  // pid alive = running (state file preserved either way)
  return { state: "running", port: state.port, host, pid: state.pid, healthy, reason, eventLoop };
}

export function readLogs(deps: LifecycleDeps): string | null {
  const logFile = resolveLifecycleFile(deps, "daemon.log");
  if (!deps.exists(logFile)) return null;
  return deps.readFile(logFile);
}

export function tailLogs(deps: LifecycleDeps, opts: { follow: boolean }): void {
  const logFile = resolveLifecycleFile(deps, "daemon.log");
  if (!deps.exists(logFile)) return;

  const args = opts.follow ? ["-f", logFile] : [logFile];
  const child = deps.spawn("tail", args, {
    env: process.env as Record<string, string>,
    stdio: "inherit" as unknown,
    detached: false,
  });
  child.unref();
}

/**
 * OPR.0.4.3.21 — read event-loop wedge evidence from a healthz probe result.
 * A plain `{ ok: true }` (mocks, or a monitor-less daemon) → healthy with no
 * evidence. When the enriched body carries an `eventLoop` block, its `healthy`
 * verdict is honored (a starved loop that still answers healthz reports
 * process-present/unhealthy with the loop-lag evidence attached).
 */
async function readHealthEvidence(
  res: { ok: boolean; json?: () => Promise<unknown> },
): Promise<{ healthy: boolean; reason?: DaemonStatus["reason"]; eventLoop?: DaemonEventLoopEvidence }> {
  if (!res.ok) return { healthy: false };
  if (!res.json) return { healthy: true };
  try {
    const body = (await res.json()) as { eventLoop?: Partial<DaemonEventLoopEvidence> } | null;
    const el = body?.eventLoop;
    if (el && typeof el.healthy === "boolean" && typeof el.lagMeanMs === "number") {
      const eventLoop: DaemonEventLoopEvidence = {
        lagMeanMs: el.lagMeanMs,
        lagP99Ms: typeof el.lagP99Ms === "number" ? el.lagP99Ms : 0,
        utilization: typeof el.utilization === "number" ? el.utilization : 0,
        lastTickAgeMs: typeof el.lastTickAgeMs === "number" ? el.lastTickAgeMs : 0,
        healthy: el.healthy,
      };
      return el.healthy
        ? { healthy: true, eventLoop }
        : { healthy: false, reason: "event-loop-starved", eventLoop };
    }
  } catch {
    // Body absent / not JSON — treat as plain healthy (res.ok already true).
  }
  return { healthy: true };
}

async function fetchDaemonProbe(deps: LifecycleDeps, url: string, timeoutMs: number): Promise<{ ok: boolean; json?: () => Promise<unknown> }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.fetch(url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HealthProbeTimeoutError(url)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 51-09 increment 3 — best-effort read of the daemon's boot-reconciled self-host
 * id from `/healthz`, for the CLI-direct send edge (the `From:` triple + the
 * reply-hint self-strip). ONE identity source (rider b): the same `/healthz`
 * field the daemon exposes, fetched on the SAME resolved local-daemon `url` the
 * send already uses — no second resolution path. Bounded by the existing
 * `HEALTHZ_PROBE_TIMEOUT_MS` (one timeout convention, not a new knob). C1
 * fail-open: returns `undefined` on ANY error / timeout / missing field — never
 * throws, never a hard daemon dependency, no new failure mode on the plain send
 * path (the envelope simply renders today's two-part form).
 */
export async function fetchSelfHostId(deps: LifecycleDeps, url: string): Promise<string | undefined> {
  try {
    const base = url.replace(/\/+$/, "");
    const res = await fetchDaemonProbe(deps, `${base}/healthz`, HEALTHZ_PROBE_TIMEOUT_MS);
    if (!res.ok || !res.json) return undefined;
    const body = (await res.json()) as { selfHostId?: unknown } | null;
    const id = body?.selfHostId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This host's own identity AND where it came from, for the surfaces that must make the state legible
 * before a cross-machine message fails. Same fail-open contract as `fetchSelfHostId`: unreachable
 * daemon yields undefined rather than a new failure mode.
 */
export async function fetchSelfHostIdentity(
  deps: LifecycleDeps,
  url: string,
): Promise<{ selfHostId: string; selfHostIdSource?: string } | undefined> {
  try {
    const base = url.replace(/\/+$/, "");
    const res = await fetchDaemonProbe(deps, `${base}/healthz`, HEALTHZ_PROBE_TIMEOUT_MS);
    if (!res.ok || !res.json) return undefined;
    const body = (await res.json()) as { selfHostId?: unknown; selfHostIdSource?: unknown } | null;
    const id = body?.selfHostId;
    if (typeof id !== "string" || id.length === 0) return undefined;
    const source = body?.selfHostIdSource;
    return {
      selfHostId: id,
      ...(typeof source === "string" && source.length > 0 ? { selfHostIdSource: source } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * A4 HTTP-path origin-triple carry: resolve THIS host's `selfHostId` for a REMOTE-targeting client,
 * so the stamped X-OpenRig-Session becomes the origin TRIPLE (member@rig@selfHostId) and the remote
 * daemon renders the ORIGIN host. The id comes from the LOCAL daemon's /healthz (env OPENRIG_URL,
 * else the running local daemon), via the shipped fail-open `fetchSelfHostId`. C1 fail-open all the
 * way down: no env URL and no running local daemon ⇒ `undefined` ⇒ the 2-part header stamps (today's
 * behavior, no new failure mode). This is THIS host's own derived id, never a caller-supplied string.
 */
export async function resolveOriginSelfHostId(deps: LifecycleDeps): Promise<string | undefined> {
  // C1 fail-open around the WHOLE resolution, not just fetchSelfHostId: a remote op must NEVER depend on
  // local daemon health. getDaemonStatus can throw (down / mid-restart / minimal test deps); ANY failure
  // ⇒ undefined ⇒ the 2-part header stamps (today's behavior). Pin 5: no new failure mode on the remote path.
  try {
    let localUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
    if (!localUrl) {
      const status = await getDaemonStatus(deps);
      if (status.state === "running" && status.port !== undefined) localUrl = getDaemonUrl(status);
    }
    if (!localUrl) return undefined;
    return await fetchSelfHostId(deps, localUrl);
  } catch {
    return undefined;
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * OPR.0.4.2.1 — status-probe-LOCAL bounded settle/retry around fetchDaemonProbe. A single /healthz
 * fetch loses to the post-restart listener bind window (process up but not yet accepting), yielding
 * a false 'down'/'unhealthy'. Retry a HARD-BOUNDED number of attempts with a short backoff so the
 * status probe reflects the ACTUAL /healthz answer. Bounded by construction: a genuine-down answers
 * nothing, every attempt fails, the final error is rethrown (reported as stopped/unhealthy) — never
 * masked, never an unbounded wait. Used ONLY by getDaemonStatus; start/stop/checkPid keep their own
 * timing (start already has its own poll loop).
 */
async function probeHealthzWithSettle(deps: LifecycleDeps, url: string): Promise<{ ok: boolean; json?: () => Promise<unknown> }> {
  const sleep = deps.sleep ?? defaultSleep;
  // ONE ~5s deadline for the whole status probe. Each attempt gets the REMAINING
  // budget (never a fresh 5s), so a slow-but-answering /healthz is observed within
  // the window. A probe TIMEOUT means the deadline is spent -> stop (no re-allocation);
  // only IMMEDIATE connection errors (the post-restart bind window) retry, bounded by
  // BOTH the attempt cap and the deadline. Genuine connection-refusal exhausts the
  // bounded retries and is rethrown (reported stopped/unhealthy) — never masked.
  const deadline = Date.now() + STATUS_PROBE_DEADLINE_MS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= STATUS_PROBE_MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await fetchDaemonProbe(deps, url, remaining);
    } catch (err) {
      lastErr = err;
      if (err instanceof HealthProbeTimeoutError) break; // deadline spent — do not re-allocate a new window
      if (attempt < STATUS_PROBE_MAX_ATTEMPTS && Date.now() + STATUS_PROBE_RETRY_DELAY_MS < deadline) {
        await sleep(STATUS_PROBE_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

// V0.3.1 slice 05 kernel-rig-as-default — forward-fix #3 architectural.
// Poll GET /api/kernel/status until kernel_state reaches ready or
// partial_ready (the two "operator can use the kernel" states) or the
// timeout elapses. Used by `rig daemon start --wait-for-kernel`.
//
// Returns { ok: true, ... } on success; { ok: false, ... } with the
// last observed kernelState + detail for the CLI's 3-part error.
export interface KernelReadyResult {
  ok: boolean;
  kernelState: string | null;
  variant: string | null;
  detail: string | null;
}

export async function waitForKernelReady(
  baseUrl: string,
  timeoutMs: number,
  pollIntervalMs = 500,
): Promise<KernelReadyResult> {
  const deadline = Date.now() + timeoutMs;
  let last: KernelReadyResult = { ok: false, kernelState: null, variant: null, detail: null };
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/kernel/status`);
      if (res.ok) {
        const body = (await res.json()) as {
          kernel_state?: string;
          variant?: string | null;
          detail?: string | null;
        };
        last = {
          ok: body.kernel_state === "ready" || body.kernel_state === "partial_ready",
          kernelState: body.kernel_state ?? null,
          variant: body.variant ?? null,
          detail: body.detail ?? null,
        };
        if (last.ok) return last;
        // Terminal non-ready states: don't keep polling.
        if (
          body.kernel_state === "auth_blocked" ||
          body.kernel_state === "spec_missing" ||
          body.kernel_state === "bootstrap_failed" ||
          body.kernel_state === "degraded" ||
          body.kernel_state === "skipped"
        ) {
          return last;
        }
      }
    } catch {
      // Transient fetch failure; keep polling until the deadline.
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return last;
}
