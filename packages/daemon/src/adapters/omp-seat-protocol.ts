// The pure contract between the OMP runtime adapter, the OMP resume adapter and the seat extension

import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";
import {
  EFFORT_SHAPE, OMP_PROVIDER_ENV_VARS, OMP_PROVIDER_EXTRA_ENV_VARS, piSeatPaths, providerFromModel,
  buildPendingRunnerState, parsePiRunnerState, type PiRunnerState,
} from "./pi-runner-protocol.js";

// ── Seat state layout ────────────────────────────────────────────────────────
// <stateRoot>/<sessionName>                    → HOME for this seat's OMP
// <stateRoot>/<sessionName>/agent              → PI_CODING_AGENT_DIR (auth, models, skills, AGENTS.md)
// <stateRoot>/<sessionName>/sessions           → --session-dir and PI_CODING_AGENT_SESSION_DIR
// <stateRoot>/<sessionName>/runner-state.json  → the seat sidecar (the name predates the native launch)
// <stateRoot>/<sessionName>/openrig-launch.yml → the settings overlay this launch passes with --config
// <stateRoot>/<sessionName>/plugins/<id>       → the plugins this seat selected, loaded with -e

export interface OmpSeatPaths {
  seatRoot: string;
  agentDir: string;
  sessionsDir: string;
  /** Native seat sidecar. The RPC runner uses a separate state root and resume-token type. */
  statePath: string;
  launchConfigPath: string;
  pluginsDir: string;
  selectedPluginsPath: string;
}

export function ompSeatPaths(stateRoot: string, sessionName: string): OmpSeatPaths {
  const base = piSeatPaths(stateRoot, sessionName);
  return {
    seatRoot: base.seatRoot,
    agentDir: base.agentDir,
    sessionsDir: base.sessionsDir,
    statePath: base.runnerStatePath,
    launchConfigPath: nodePath.join(base.seatRoot, "openrig-launch.yml"),
    pluginsDir: nodePath.join(base.seatRoot, "plugins"),
    selectedPluginsPath: nodePath.join(base.seatRoot, "selected-plugins.json"),
  };
}

// ── Seat sidecar ─────────────────────────────────────────────────────────────

/** What the seat extension writes. The first fields are the ones every reader of a Pi-family sidecar already
 *  understands (ready, launchId, sessionFile, sessionId, exited); the rest are OMP's own. */
export interface OmpSeatState extends PiRunnerState {
  nodeId?: string;
  generation?: string;
  inputProtocol?: number;
  /** sha256 identifies the requested paste. A different editor representation has its own digest. */
  inputReceipt?: { sequence: number; requestId: string; sha256: string; stagedSha256?: string };
  /** The extension's contract version, for diagnosis. */
  protocol?: number;
  /** OMP's process id, as the extension saw it. */
  pid?: number;
  /** Whether the session has a model it can call: OMP starts without credentials and fails only at the first prompt. */
  auth?: "ok" | "missing" | "unknown";
  /** The model the session is on, as `provider/id`. Reporting only. */
  model?: string;
}

export function parseOmpSeatState(raw: string): OmpSeatState | null {
  return parsePiRunnerState(raw) as OmpSeatState | null;
}

/** The record written before a launch is typed, so nothing from an earlier OMP process can answer for this one. */
export function buildPendingOmpSeatState(launchId: string, updatedAt: string): OmpSeatState {
  return buildPendingRunnerState(launchId, updatedAt, null);
}

// ── The launch settings overlay ──────────────────────────────────────────────

/** Settings a managed launch pins for this run with `--config`. The seat's own config.yml is never edited: a person's
 *  choices there stand, except that a managed seat doesn't stop at first-run setup, doesn't offer its own update, and
 *  opens the session the launch names rather than the directory's last one. */
export const OMP_LAUNCH_CONFIG = [
  "# Written by OpenRig for this managed seat at each launch; edits are overwritten.",
  "startup:",
  "  setupWizard: false",
  "  checkUpdate: false",
  "autoResume: false",
  "",
].join("\n");

// ── Environment (deny by default) ────────────────────────────────────────────

/** What a terminal UI and its shell tools need. HOME is not here: the seat gets its own. SSH_AUTH_SOCK lets the
 *  agent's shell tools run git over SSH; the path isn't key material, but the socket lets the agent use the keys
 *  loaded in ssh-agent. TMUX and TMUX_PANE let OMP's terminal handling know it is drawing inside tmux. */
export const OMP_ENV_BASELINE_VARS = [
  "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "SSH_AUTH_SOCK",
  "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMUX", "TMUX_PANE",
] as const;

/** The seat's identity and its daemon's address, so `rig` commands the agent runs resolve as this seat on this
 *  instance. OPENRIG_ACTIVITY_HOOK_TOKEN is deliberately absent: it speaks for every seat, OMP hands its whole
 *  environment to the shell tools it runs, and the extension can't remove a variable from that. The extension reads
 *  the token from the instance's activity-endpoint.json instead. */
export const OMP_ENV_OPENRIG_VARS = [
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_OCCUPANT_GENERATION",
  "OPENRIG_HOME", "OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT", "OPENRIG_SHARED_DOCS_ROOT",
  // Selected openrig-core plugins must honor the seat's explicit refocus configuration.
  "OPENRIG_REFOCUS_ENABLED", "OPENRIG_REFOCUS_BUDGET_MS", "OPENRIG_REFOCUS_BYTES",
  "OPENRIG_REFOCUS_CONTENT_FILE", "OPENRIG_REFOCUS_CONTENT_REF", "OPENRIG_REFOCUS_DEPTH",
  "OPENRIG_REFOCUS_NOW", "OPENRIG_REFOCUS_TOPOLOGY_NODE", "OPENRIG_REFOCUS_TREES",
  "OPENRIG_REFOCUS_WORK_NODE", "OPENRIG_REFOCUS_WORK_PACKET",
] as const;

/** The names forwarded from the pane's environment: the baseline, the seat's identity, and the credential of the
 *  model's declared provider (with its endpoint, for a provider whose key belongs to one). Nothing else crosses. */
export function ompForwardedEnvNames(model: string | undefined): string[] {
  const provider = providerFromModel(model);
  const key = provider && Object.hasOwn(OMP_PROVIDER_ENV_VARS, provider) ? OMP_PROVIDER_ENV_VARS[provider] : undefined;
  return [
    ...OMP_ENV_BASELINE_VARS,
    ...OMP_ENV_OPENRIG_VARS,
    ...(key ? [key] : []),
    ...(provider && Object.hasOwn(OMP_PROVIDER_EXTRA_ENV_VARS, provider) ? OMP_PROVIDER_EXTRA_ENV_VARS[provider]! : []),
  ];
}

// ── Command construction ─────────────────────────────────────────────────────

export interface OmpLaunchOpts {
  /** `omp`, or its absolute path when the daemon resolved one on its launch PATH. */
  ompCommand: string;
  paths: OmpSeatPaths;
  /** Managed working directory for the session. */
  cwd: string;
  /** Launch-attempt scope the extension stamps into every sidecar write. */
  launchId: string;
  /** Absolute path to the seat extension (assets/omp/openrig-seat.js). */
  seatExtensionPath: string;
  /** Plugin directories this seat selected, each loaded as an OMP extension package (its skills come with it). */
  pluginRoots?: readonly string[];
  /** Optional `provider/id` model declaration. */
  model?: string;
  /** The seat's resolved effort, sent as OMP's `--thinking` when it has set-effort's shape. */
  thinking?: string;
  approvalMode: "yolo" | "always-ask";
  seatSkillsRoot?: string;
  /** Exact session file to resume. Mutually exclusive with forkRef. */
  sessionFile?: string;
  /** Session file to fork into a new session. */
  forkRef?: string;
  /** Where the extension writes context usage for the context monitor. */
  contextSidecarPath?: string;
  /** The interpreter a selected plugin's hook scripts run with (OPENRIG_NODE), so they never depend on `node` being on
   *  the seat's PATH. */
  nodeExecutable?: string;
}

/** The `--thinking` value a launch sends: only one of set-effort's shape, so it can never read as another flag. */
export function ompThinkingValue(thinking: string | null | undefined): string | undefined {
  const value = thinking?.trim();
  return value && EFFORT_SHAPE.test(value) ? value : undefined;
}

/** Resolve the reporting PID through the bound pane, including wrappers that fork the OMP child. */
export function ompProcessInPane<T extends { pid: number; ppid: number; startedAt?: string; state?: string }>(
  rows: readonly T[], panePid: number, state: OmpSeatState,
): T | undefined {
  if (!state.ready || state.exited || !state.pid || !state.launchId) return undefined;
  const processes = new Map(rows.map(row => [row.pid, row]));
  const writer = processes.get(state.pid);
  if (!writer || writer.state === "Z") return undefined;
  const seen = new Set<number>();
  for (let row: T | undefined = writer; row && !seen.has(row.pid); row = processes.get(row.ppid)) {
    if (row.pid === panePid || row.ppid === panePid) return writer;
    seen.add(row.pid);
  }
  return undefined;
}

/** OMP's own arguments (argv-style, unquoted), for tests and for the command below. */
export function buildOmpArgs(opts: OmpLaunchOpts): string[] {
  const args = [
    "--cwd", opts.cwd,
    // The flag wins over the environment in OMP; both are set so the seat's sessions stay its own if one regresses.
    "--session-dir", opts.paths.sessionsDir,
    "--approval-mode", opts.approvalMode,
    "--config", opts.paths.launchConfigPath,
    "-e", opts.seatExtensionPath,
  ];
  if (opts.seatSkillsRoot) args.push("-e", nodePath.dirname(opts.seatSkillsRoot));
  for (const root of opts.pluginRoots ?? []) args.push("-e", root);
  if (opts.model?.trim()) args.push("--model", opts.model.trim());
  const thinking = ompThinkingValue(opts.thinking);
  if (thinking) args.push("--thinking", thinking);
  if (opts.sessionFile) {
    // The exact file, never the picker: `--session` with a value opens that session or exits.
    args.push("--session", opts.sessionFile);
  } else if (opts.forkRef) {
    args.push("--fork", opts.forkRef);
  }
  return args;
}

/** The variables this launch sets itself. None is a secret. */
export function buildOmpFixedEnv(opts: OmpLaunchOpts): Record<string, string> {
  return {
    // A per-seat HOME keeps OMP away from the operator's ~/.omp and ~/.env. The working directory's own .env is still
    // read by OMP, as for any OMP run there.
    HOME: opts.paths.seatRoot,
    PI_CODING_AGENT_DIR: opts.paths.agentDir,
    PI_CODING_AGENT_SESSION_DIR: opts.paths.sessionsDir,
    // A fresh seat home would otherwise open OMP's first-run setup instead of its prompt.
    OMP_SKIP_SETUP: "1",
    OPENRIG_RUNTIME: "omp-tui",
    OPENRIG_OMP_SEAT_STATE: opts.paths.statePath,
    OPENRIG_OMP_LAUNCH_ID: opts.launchId,
    OPENRIG_OMP_APPROVAL_MODE: opts.approvalMode,
    OPENRIG_OMP_SESSION_SOURCE: opts.sessionFile ? "resume" : opts.forkRef ? "fork" : "startup",
    ...(opts.contextSidecarPath ? { OPENRIG_OMP_CONTEXT_SIDECAR: opts.contextSidecarPath } : {}),
    ...(opts.nodeExecutable ? { OPENRIG_NODE: opts.nodeExecutable } : {}),
  };
}

/**
 * The command typed into the seat's pane (staged in a script and exec'd by /bin/sh, so the pane's own shell never
 * parses it). `env -i` starts OMP with an empty environment plus the forwarded names, each written as
 * `${NAME+"NAME=$NAME"}`: the shell that runs this supplies the value, and an unset name adds nothing. The inner
 * `sh -c` exists so those expansions read the environment this command was started with, including whatever the seat
 * launch environment put in front of it (the seat's identity and the paired `rig` on PATH).
 */
export function buildOmpLaunchCommand(opts: OmpLaunchOpts): string {
  const forwarded = ompForwardedEnvNames(opts.model).map((name) => `\${${name}+"${name}=$${name}"}`).join(" ");
  const fixed = Object.entries(buildOmpFixedEnv(opts)).map(([name, value]) => shellQuote(`${name}=${value}`));
  return [
    "/bin/sh", "-c", shellQuote(`exec /usr/bin/env -i ${forwarded} "$@"`), "openrig-omp",
    ...fixed,
    shellQuote(opts.ompCommand),
    ...buildOmpArgs(opts).map(shellQuote),
  ].join(" ");
}

/** The folder a selected plugin is copied to under the seat's plugins directory. A plugin's id can carry a source
 *  prefix (`shared:openrig-core`); the folder name keeps to characters every path reader takes literally. */
export function ompPluginDirName(effectiveId: string): string {
  if (!effectiveId || effectiveId === "." || effectiveId === "..") throw new Error("Invalid OMP plugin ID");
  return encodeURIComponent(effectiveId);
}
