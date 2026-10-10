// OPR.0.4.6.PI1 — the shared, PURE contract between the Pi runtime adapter,
// the Pi resume adapter, and the pane-hosted pi-runner process.
//
// Everything here is side-effect-free (constants + string/argv/env builders +
// the runner-state sidecar shape) so the runner entry can import it without
// dragging daemon dependencies into the pane process, and the adapter/resume
// tests can assert command construction hermetically.
//
// Contract summary (PRD FR-2/FR-3/FR-5/FR-7):
// - The adapter launches `node <runnerEntry> …` inside the seat's tmux pane.
// - The runner spawns `pi --mode rpc` with seat-scoped PI_CODING_AGENT_DIR /
//   PI_CODING_AGENT_SESSION_DIR and a deny-by-default env allowlist (BR-3).
// - Every managed launch carries an EXPLICIT trust flag (BR-5) — ambient
//   `ask` silently skips in RPC mode, it never asks.
// - The runner persists `runner-state.json` (the sidecar) from RPC
//   `get_state`, and prints the READY marker to the pane; the daemon reads
//   ONLY runner-authored surfaces — never Pi TUI heuristics (BR-1).

import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";
export type RunnerRuntime = "pi" | "omp";

// ── Seat state layout ────────────────────────────────────────────────────────
// <stateRoot>/<sessionName>/agent     → PI_CODING_AGENT_DIR (auth.json, models.json, skills, …)
// <stateRoot>/<sessionName>/sessions  → PI_CODING_AGENT_SESSION_DIR (+ explicit --session-dir; flag wins)
// <stateRoot>/<sessionName>/runner-state.json → the runner's session-identity sidecar

export interface PiSeatPaths {
  seatRoot: string;
  agentDir: string;
  sessionsDir: string;
  runnerStatePath: string;
}

export function piSeatPaths(stateRoot: string, sessionName: string): PiSeatPaths {
  const seatRoot = nodePath.join(stateRoot, sessionName);
  return {
    seatRoot,
    agentDir: nodePath.join(seatRoot, "agent"),
    sessionsDir: nodePath.join(seatRoot, "sessions"),
    runnerStatePath: nodePath.join(seatRoot, "runner-state.json"),
  };
}

// ── Pane markers (runner-authored; the adapter greps for THESE, never Pi UI) ─

export const PI_RUNNER_READY_MARKER = "[pi-runner] READY";
export const PI_RUNNER_EXIT_MARKER = "[pi-runner] EXITED";
export const PI_RUNNER_ERROR_MARKER = "[pi-runner] ERROR";

// ── Runner-state sidecar ─────────────────────────────────────────────────────

export interface PiRunnerState {
  ready: boolean;
  /** Launch-attempt scope (guard fold, code-review qitem-20260707011908):
   *  the adapter mints a launchId per attempt, pre-writes a pending sidecar
   *  carrying it, and passes --launch-id to the runner; the runner stamps it
   *  into every sidecar write. Readiness/resume polls IGNORE any state whose
   *  launchId differs — durable artifacts from prior runner instances can
   *  never false-green a new launch or false-fail it with a stale exit. */
  launchId?: string;
  /** Absolute session-file path from RPC get_state — the resume token. */
  sessionFile?: string;
  /** UUIDv7 session id from get_state — display/fallback metadata. */
  sessionId?: string;
  /** Durable catch-up cursor: last session-entry id projected to the bus. */
  lastEntryId?: string;
  /** ISO timestamp of the last sidecar write. */
  updatedAt: string;
  /** Set when the pi process exited; the seat is honestly non-running. */
  exited?: { code: number | null; at: string };
}

/** The launch-scoped pending record every writer uses when resetting the
 *  sidecar for a new attempt. It deliberately CARRIES the prior lastEntryId:
 *  the durable catch-up cursor (FR-5) must survive the stale-artifact reset —
 *  erasing it broke get_entries-since on resume (guard re-verdict,
 *  qitem-20260707013815). Everything else from the prior record is exactly
 *  the stale state the reset exists to scope away. */
export function buildPendingRunnerState(
  launchId: string,
  updatedAt: string,
  prior: PiRunnerState | null,
): PiRunnerState {
  return {
    ready: false,
    launchId,
    lastEntryId: prior?.lastEntryId,
    updatedAt,
  };
}

export function parsePiRunnerState(raw: string): PiRunnerState | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const state = parsed as Record<string, unknown>;
    if (typeof state.ready !== "boolean" || typeof state.updatedAt !== "string") return null;
    return parsed as unknown as PiRunnerState;
  } catch {
    return null;
  }
}

// ── Provider env passthrough (BR-3 / FR-7) ──────────────────────────────────
// Deny-by-default: only baseline vars, managed identity/instance locators and
// the DECLARED provider's key cross into Pi. Extending this map is a reviewed change,
// never a convenience edit. Custom/local providers configure keys via the
// seat's managed models.json instead (their vars are not ambient-forwarded).

export const PI_PROVIDER_ENV_VARS: Record<string, string> = {
  // Forward only the API key for the model's declared provider.
  "openrouter": "OPENROUTER_API_KEY",
  "zai": "ZAI_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  "minimax": "MINIMAX_API_KEY",
};

/** Explicit OMP chat-provider credential names. Only the declared provider's
 *  key can cross into the child; arbitrary *_KEY variables are never forwarded. */
export const OMP_PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-codex": "OPENAI_CODEX_OAUTH_TOKEN",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  zai: "ZAI_API_KEY",
  "zhipu-coding-plan": "ZHIPU_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  together: "TOGETHER_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-code": "MINIMAX_CODE_API_KEY",
  "minimax-code-cn": "MINIMAX_CODE_CN_API_KEY",
  qianfan: "QIANFAN_API_KEY",
  "qwen-portal": "QWEN_PORTAL_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "opencode-zen": "OPENCODE_API_KEY",
  huggingface: "HUGGINGFACE_HUB_TOKEN",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  "ollama-cloud": "OLLAMA_CLOUD_API_KEY",
  baseten: "BASETEN_API_KEY",
  deepinfra: "DEEPINFRA_API_KEY",
  siliconflow: "SILICONFLOW_API_KEY",
  "siliconflow-cn": "SILICONFLOW_CN_API_KEY",
  litellm: "LITELLM_API_KEY",
};

/** Providers whose credential is a (key, endpoint) PAIR. A gateway, proxy or
 *  compatible endpoint issues a key that is only valid against one base URL, so
 *  sending the key alone hands the seat an unusable credential. startup's
 *  KNOWN_PROVIDER_AUTH_ENV already makes this pairing for ANTHROPIC_BASE_URL and
 *  OPENAI_BASE_URL; those reach a seat's launch env but die at the child
 *  boundary below without an entry here.
 *
 *  Each entry is the provider's key variable with _API_KEY swapped for _BASE_URL
 *  (asserted in omp-runner tests). The bar for an entry is that OMP's CHAT
 *  provider reads that variable as an endpoint override: a base URL OMP holds
 *  as a fixed constant, or reads only in another package, earns none —
 *  forwarding it would do nothing, or would mislead someone pointing chat at a
 *  proxy. Extending this map is a reviewed change, never a convenience edit,
 *  and the other OMP providers deliberately have none. */
export const OMP_PROVIDER_EXTRA_ENV_VARS: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_BASE_URL"],
  openai: ["OPENAI_BASE_URL"],
  litellm: ["LITELLM_BASE_URL"],
};

// Baseline process needs. No host credential families or shell customization.
export const PI_ENV_BASELINE_VARS = ["PATH", "HOME", "USER", "LOGNAME", "TERM", "LANG", "LC_ALL", "SHELL", "TMPDIR"] as const;

// NodeLauncher supplies identity and instance routing on both fresh and resumed
// seats. Pi's shell tools inherit this child env: dropping these values makes
// ordinary whoami/send/queue resolve as an unmanaged caller or another instance.
// Preserve supplied runtime/generation and legacy context-root provenance too;
// never synthesize identity or forward arbitrary OPENRIG_* settings/tokens.
const PI_ENV_OPENRIG_VARS = [
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "OPENRIG_OCCUPANT_GENERATION",
  "OPENRIG_HOME", "OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT", "OPENRIG_SHARED_DOCS_ROOT",
] as const;

/** Model declaration: Pi accepts `--model provider/id`. The provider segment
 *  (before the first "/") selects the env passthrough var, if any. */
export function providerFromModel(model: string | undefined): string | null {
  const trimmed = model?.trim() ?? "";
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  return trimmed.slice(0, slash);
}

/** Build the deny-by-default env for the pi child process (BR-3). `source` is
 *  the runner's own env; only allowlisted names cross the boundary. */
export function buildPiChildEnv(
  source: Record<string, string | undefined>,
  opts: { agentDir: string; sessionsDir: string; model?: string; runtime?: RunnerRuntime; sessionName?: string; nodeId?: string; openrigHome?: string; openrigUrl?: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...PI_ENV_BASELINE_VARS, ...PI_ENV_OPENRIG_VARS]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.PI_CODING_AGENT_DIR = opts.agentDir;
  env.PI_CODING_AGENT_SESSION_DIR = opts.sessionsDir;
  const provider = providerFromModel(opts.model);
  const providerVar = provider ? (opts.runtime === "omp" ? OMP_PROVIDER_ENV_VARS : PI_PROVIDER_ENV_VARS)[provider] : undefined;
  if (providerVar && source[providerVar] !== undefined) {
    env[providerVar] = source[providerVar]!;
  }
  // The declared provider's endpoint, for the providers whose key is scoped to one.
  if (opts.runtime === "omp" && provider) {
    for (const extra of OMP_PROVIDER_EXTRA_ENV_VARS[provider] ?? []) {
      const value = source[extra];
      if (value !== undefined) env[extra] = value;
    }
  }
  if (opts.runtime === "omp") {
    // The per-seat HOME prevents OMP from consulting the operator's ~/.omp
    // and ~/.env. Project cwd/.env remains an OMP discovery surface. The
    // runner resolves the OMP binary before this HOME applies.
    env.HOME = nodePath.dirname(opts.agentDir);
    // OMP seats also pin their managed identity and daemon locator from the
    // runner's own arguments (never the hook token, which belongs to the
    // runner's POST client).
    if (opts.sessionName) env.OPENRIG_SESSION_NAME = opts.sessionName;
    env.OPENRIG_RUNTIME = "omp";
    if (opts.nodeId) env.OPENRIG_NODE_ID = opts.nodeId;
    if (opts.openrigHome) env.OPENRIG_HOME = opts.openrigHome;
    if (opts.openrigUrl) env.OPENRIG_URL = opts.openrigUrl;
  }
  return env;
}

// ── Command construction ─────────────────────────────────────────────────────

export interface PiRunnerLaunchOpts {
  /** Explicit runtime; omitted keeps the original Pi command byte-for-byte. */
  runtime?: RunnerRuntime;
  /** Absolute path to the compiled runner entry (daemon dist). */
  runnerEntryPath: string;
  /** The seat's canonical session name (identity + sidecar key). */
  sessionName: string;
  /** Seat state root (the <stateRoot> piSeatPaths derives from). */
  stateRoot: string;
  /** Managed working directory for the Pi session. */
  cwd: string;
  /** Optional `provider/id` model declaration (FR-7). */
  model?: string;
  /** Explicit posture; OMP maps it to --approval-mode, Pi to resource trust. */
  trust: "approve" | "no-approve";
  /** Exact session file to resume (FR-6). Mutually exclusive with forkRef. */
  sessionFile?: string;
  /** Session file path or id to fork from via CLI --fork (FR-6). */
  forkRef?: string;
  /** Launch-attempt scope stamped into every runner sidecar write. */
  launchId: string;
}

/** The command typed into the seat's tmux pane. The runner owns everything
 *  past this boundary (pi spawn, env allowlist, RPC, mirror, sidecar). */
export function buildPiRunnerCommand(opts: PiRunnerLaunchOpts): string {
  const parts = [
    "node",
    shellQuote(opts.runnerEntryPath),
    "--session-name", shellQuote(opts.sessionName),
    "--state-root", shellQuote(opts.stateRoot),
    "--cwd", shellQuote(opts.cwd),
    "--launch-id", shellQuote(opts.launchId),
    ...(opts.runtime === "omp"
      ? ["--runtime", "omp", "--approval-mode", opts.trust === "approve" ? "yolo" : "always-ask"]
      : [`--${opts.trust}`]),
  ];
  if (opts.model?.trim()) {
    parts.push("--model", shellQuote(opts.model.trim()));
  }
  if (opts.sessionFile) {
    parts.push("--session", shellQuote(opts.sessionFile));
  }
  if (opts.forkRef) {
    parts.push("--fork", shellQuote(opts.forkRef));
  }
  return parts.join(" ");
}

/** Argv for the `pi` child the RUNNER spawns (argv-style, no shell). The
 *  explicit `--session-dir` wins over env per Pi's documented precedence —
 *  both are set so the isolation holds even if one layer regresses. */
export function buildPiChildArgs(opts: {
  sessionsDir: string;
  sessionName: string;
  model?: string;
  trust: "approve" | "no-approve";
  sessionFile?: string;
  forkRef?: string;
  runtime?: RunnerRuntime;
}): string[] {
  const args = [
    "--mode", "rpc",
    "--session-dir", opts.sessionsDir,
    ...(opts.runtime === "omp"
      ? ["--approval-mode", opts.trust === "approve" ? "yolo" : "always-ask"]
      : ["--name", opts.sessionName, `--${opts.trust}`]),
  ];
  if (opts.model?.trim()) {
    args.push("--model", opts.model.trim());
  }
  if (opts.sessionFile) {
    // Exact file resume — NEVER --resume (interactive picker; forbidden in
    // managed paths, PRD FR-6).
    args.push("--session", opts.sessionFile);
  } else if (opts.forkRef) {
    // Whole-session fork with parentSession linkage — CLI --fork, NOT RPC
    // fork (which is by-entryId on the active session; a different operation).
    args.push("--fork", opts.forkRef);
  }
  return args;
}
