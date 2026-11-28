// One native OMP launch, shared by the runtime adapter (fresh, resume and fork) and the legacy resume adapter.

import { randomUUID } from "node:crypto";
import nodePath from "node:path";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import type { OmpSeatLocation } from "../domain/omp-seat-location.js";
import { observeOmpApprovalMode, type AppliedLaunchObservation } from "../domain/permission-drift.js";
import {
  OMP_LAUNCH_CONFIG, buildOmpLaunchCommand, buildPendingOmpSeatState, ompSeatPaths,
  parseOmpSeatState, type OmpSeatPaths, type OmpSeatState,
} from "./omp-seat-protocol.js";

/** The pane's foreground command while no agent runs in it. */
export const OMP_SHELL_COMMANDS: ReadonlySet<string> = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh", "dash", "ksh"]);

export function paneAtShell(command: string | null | undefined): boolean {
  return OMP_SHELL_COMMANDS.has((command ?? "").replace(/^-/, ""));
}

function wellFormedPluginName(id: string): boolean {
  try { return encodeURIComponent(decodeURIComponent(id)) === id; } catch { return false; }
}

export interface OmpLaunchFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  /** Relative paths of every file under a directory. Absent, or a throw, reads as an empty directory. */
  listFiles?(dirPath: string): string[];
}

export interface OmpSeatLauncherDeps {
  tmux: TmuxAdapter;
  fsOps: OmpLaunchFsOps;
  /** Root under which every OMP seat gets its own home. Typically <OPENRIG_HOME>/state/omp. */
  stateRoot: string;
  seatLocation?: (sessionName: string) => OmpSeatLocation;
  seatSkillsRootForSession?: (sessionName: string) => string | undefined;
  /** Absolute path to the seat extension the daemon ships (assets/omp/openrig-seat.js). */
  seatExtensionPath: string;
  seatLaunchEnvironment?: SeatLaunchEnvironment;
  /** `omp` resolved on the daemon's launch PATH, when it is there. Absent: the pane's own PATH finds it. */
  resolveOmpExecutable?: () => string | undefined;
  /** Where the extension writes this seat's context usage, for the context monitor. */
  contextSidecarPath?: (sessionName: string) => string;
  /** The interpreter a selected plugin's hook scripts run with. Absent: `node` on the seat's PATH. */
  nodeExecutable?: string;
  sleep?: (ms: number) => Promise<void>;
  newLaunchId?: () => string;
  now?: () => string;
  pollMs?: number;
  maxWaitMs?: number;
}

export interface OmpLaunchRequest {
  sessionName: string;
  cwd: string;
  model?: string | null;
  effort?: string | null;
  seatSkillsRoot?: string;
  launchPosture?: "floor" | "full_bypass" | "auto";
  launchWrapper?: readonly string[];
  beforeNativeDispatch?: () => boolean;
  nodeId?: string;
  generation?: string;
  /** Exact session file to reopen. */
  sessionFile?: string;
  /** Session file to fork into a new session. */
  forkRef?: string;
}

export type OmpLaunchOutcome =
  | { ok: true; state: OmpSeatState; appliedLaunch: AppliedLaunchObservation; warnings?: string[] }
  | { ok: false; reason: "send_failed" | "exited" | "session_not_found" | "timeout"; message: string; evidence?: string };

export class OmpSeatLauncher {
  readonly stateRoot: string;
  private readonly tmux: TmuxAdapter;
  private readonly fs: OmpLaunchFsOps;
  private readonly deps: OmpSeatLauncherDeps;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: OmpSeatLauncherDeps) {
    this.deps = deps;
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.stateRoot = deps.stateRoot;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  location(sessionName: string): OmpSeatLocation {
    return this.deps.seatLocation?.(sessionName) ?? { storageSession: sessionName, canonicalSession: sessionName };
  }

  paths(sessionName: string): OmpSeatPaths {
    return ompSeatPaths(this.stateRoot, this.location(sessionName).storageSession);
  }

  /** The seat's sidecar; null when absent or unparseable. */
  readState(sessionName: string): OmpSeatState | null {
    const { statePath } = this.paths(sessionName);
    if (!this.fs.exists(statePath)) return null;
    try {
      return parseOmpSeatState(this.fs.readFile(statePath));
    } catch {
      return null;
    }
  }

  /** Only the last successful selection can load. Retained files from deselected plugins are not executable roots. */
  readPluginSelection(sessionName: string): { roots: string[]; warning?: string } {
    const { pluginsDir, selectedPluginsPath } = this.paths(sessionName);
    let raw: string;
    try {
      raw = this.fs.readFile(selectedPluginsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { roots: [] };
      return { roots: [], warning: `OMP could not read plugin selection ${selectedPluginsPath}: ${String(error)}` };
    }
    try {
      const ids: unknown = JSON.parse(raw);
      if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string" && id.length > 0
        && id !== "." && id !== ".." && nodePath.basename(id) === id && wellFormedPluginName(id))) {
        throw new Error("expected an array of valid plugin directory names");
      }
      const roots = [...new Set(ids)].sort().map(id => nodePath.join(pluginsDir, id))
        .filter(root => this.fs.exists(nodePath.join(root, "package.json")));
      return { roots };
    } catch (error) {
      return { roots: [], warning: `OMP could not read plugin selection ${selectedPluginsPath}: ${String(error)}` };
    }
  }

  pluginRoots(sessionName: string): string[] {
    return this.readPluginSelection(sessionName).roots;
  }

  skillRoot(sessionName: string): string | undefined {
    return this.deps.seatSkillsRootForSession?.(sessionName);
  }

  async launch(request: OmpLaunchRequest): Promise<OmpLaunchOutcome> {
    const { sessionName } = request;
    request = { ...request, seatSkillsRoot: request.seatSkillsRoot ?? this.skillRoot(sessionName) };
    if (request.launchWrapper?.length && !this.deps.seatLaunchEnvironment) {
      return { ok: false, reason: "send_failed", message: "launch_wrapper support unavailable; no agent started." };
    }
    const paths = this.paths(sessionName);
    this.fs.mkdirp(paths.agentDir);
    this.fs.mkdirp(paths.sessionsDir);
    // Stock OMP discovers skills/ beneath explicit extension-package roots. Keep native user settings intact.
    if (request.seatSkillsRoot) this.fs.mkdirp(request.seatSkillsRoot);
    this.fs.writeFile(paths.launchConfigPath, OMP_LAUNCH_CONFIG);

    // Scope this attempt before anything is typed: only a sidecar the new OMP process stamps with this id counts.
    const launchId = (this.deps.newLaunchId ?? randomUUID)();
    const now = this.deps.now ?? (() => new Date().toISOString());

    const approvalMode = request.launchPosture === "full_bypass" ? "yolo" : "always-ask";
    const appliedLaunch = { ...observeOmpApprovalMode(`--approval-mode ${approvalMode}`), runtime: "omp-tui" };
    let ompCommand = "omp";
    try {
      ompCommand = this.deps.resolveOmpExecutable?.() ?? "omp";
    } catch {
      // Not on the daemon's launch PATH: leave it to the pane's.
    }
    const selection = this.readPluginSelection(sessionName);
    const bare = buildOmpLaunchCommand({
      ompCommand,
      paths,
      seatSkillsRoot: request.seatSkillsRoot,
      cwd: request.cwd,
      launchId,
      seatExtensionPath: this.deps.seatExtensionPath,
      pluginRoots: selection.roots,
      model: request.model ?? undefined,
      thinking: request.effort ?? undefined,
      approvalMode,
      sessionFile: request.sessionFile,
      forkRef: request.forkRef,
      contextSidecarPath: this.deps.contextSidecarPath?.(this.location(sessionName).canonicalSession),
      nodeExecutable: this.deps.nodeExecutable,
    });
    // The seat launch environment puts the seat's identity and the paired `rig` in front; without it the pane's own
    // environment, which the node launcher already set, is what the command forwards.
    let command: string;
    try {
      command = this.deps.seatLaunchEnvironment
        ? await this.deps.seatLaunchEnvironment.command(sessionName, bare, {
          nodeId: request.nodeId, generation: request.generation, runtime: "omp-tui", launchWrapper: request.launchWrapper,
        }) : bare;
    } catch {
      return { ok: false, reason: "send_failed", message: "OMP launch environment unavailable; no agent started." };
    }
    // Always staged: /bin/sh runs it from a private script, whatever shell the pane has, and exec replaces that sh.
    const wanted = request.sessionFile ?? request.forkRef;
    const priorPane = wanted ? await this.tmux.capturePaneContent(sessionName, 40).catch(() => null) : null;
    if (request.beforeNativeDispatch && !request.beforeNativeDispatch()) {
      return { ok: false, reason: "send_failed", message: "OMP launch selection changed before dispatch." };
    }
    this.fs.writeFile(paths.statePath, JSON.stringify(buildPendingOmpSeatState(launchId, now())));
    const sent = await this.tmux.sendShellCommand(sessionName, command, undefined, { execInScript: true });
    if (!sent.ok) return { ok: false, reason: "send_failed", message: `Failed to send launch command: ${sent.message}` };

    const outcome = await this.waitForSeat(sessionName, launchId, appliedLaunch, wanted, priorPane);
    return outcome.ok && selection.warning ? { ...outcome, warnings: [selection.warning] } : outcome;
  }

  /** Wait for THIS attempt's sidecar. A pane that returns to its shell first means OMP exited without loading the
   *  extension: a session it couldn't find, a bad flag, or a binary that isn't there. */
  private async waitForSeat(sessionName: string, launchId: string, appliedLaunch: AppliedLaunchObservation, wanted: string | undefined, priorPane: string | null): Promise<OmpLaunchOutcome> {
    const pollMs = this.deps.pollMs ?? 250;
    const attempts = Math.max(1, Math.floor((this.deps.maxWaitMs ?? 20_000) / Math.max(pollMs, 1)) + 1);
    // The staged script needs a moment to replace the shell; before that a shell in the foreground is expected.
    const shellGraceAttempts = Math.max(1, Math.ceil(3_000 / Math.max(pollMs, 1)));
    let shellSeen = 0;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const state = this.readState(sessionName);
      if (state?.launchId === launchId) {
        if (state.exited) {
          return { ok: false, reason: "exited", message: `OMP exited during startup (code ${state.exited.code ?? "unknown"})`, evidence: await this.paneTail(sessionName) };
        }
        if (state.ready) return { ok: true, state, appliedLaunch };
      }
      if (attempt >= shellGraceAttempts && attempt % 4 === 0) {
        shellSeen = paneAtShell(await this.tmux.getPaneCommand(sessionName)) ? shellSeen + 1 : 0;
        if (shellSeen >= 2) {
          const pane = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
          const evidence = pane.split("\n").filter((line) => line.trim()).slice(-12).join("\n");
          const diagnostic = wanted ? `Error: Session "${wanted}" not found.` : null;
          return diagnostic && priorPane !== null && !priorPane.includes(diagnostic) && pane.includes(diagnostic)
            ? { ok: false, reason: "session_not_found", message: "OMP reports that the requested session does not exist", evidence }
            : { ok: false, reason: "exited", message: "OMP exited during startup, before it reported ready", evidence };
        }
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return { ok: false, reason: "timeout", message: "timed out waiting for OMP to report ready" };
  }

  private async paneTail(sessionName: string): Promise<string> {
    const pane = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
    return pane.split("\n").filter((line) => line.trim()).slice(-12).join("\n");
  }
}
