import { piAccountSwitchStateRoot } from "../domain/pi-account-state.js";
// OPR.0.4.6.PI1 — the Pi runtime adapter (RPC-first, runner-in-a-pane).
//
// The adapter launches the OpenRig-owned pi-runner inside the seat's normal
// tmux pane; the runner hosts `pi --mode rpc` (headless JSONL — Pi's
// first-class integration surface). send/capture stay tmux-native and are NOT
// adapter methods (the runner forwards pane stdin to RPC prompt/steer and
// mirrors a legible transcript to pane stdout); activity + session identity
// come from Pi's typed RPC events + get_state via the runner's sidecar and
// bus emission — never pane scraping (BR-1). TUI-native Pi is a SEPARATE
// future contract, never a hidden mode here (BR-2).

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import { piTrust, yoloEnabled } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { isPerSeatRoleGuidance, perSeatRoleSkipWarning } from "../domain/managed-blocks.js";
import { writeManagedGuidanceBlock, type ManagedBlockRecords } from "../domain/managed-block-records.js";
import { guidanceFileSharedByLink } from "../domain/restore-guidance.js";
import { observePiResourceTrust, observeOmpApprovalMode } from "../domain/permission-drift.js";
import {
  piSeatPaths, parsePiRunnerState, buildPiRunnerCommand, buildPendingRunnerState,
  PI_RUNNER_READY_MARKER, PI_RUNNER_ERROR_MARKER, PI_RUNNER_EXIT_MARKER,
  type PiRunnerState, type RunnerRuntime,
} from "./pi-runner-protocol.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface PiAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
  /** Whether a path is a symlink and its hard-link count, or null when it doesn't exist (an lstat). */
  linkInfo?(path: string): { link: boolean; nlink: number } | null;
}

export interface PiRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  seatLaunchEnvironment?: SeatLaunchEnvironment;
  fsOps: PiAdapterFsOps;
  /** Root under which every Pi seat gets its isolated state dir (FR-7).
   *  Typically <OPENRIG_HOME>/state/pi. */
  stateRoot: string;
  stateRootForSession?: (session: string) => string;
  /** Absolute path to the compiled pi-runner entry in the daemon dist. */
  runnerEntryPath: string;
  /** Trust posture for managed launches (BR-5 — always explicit; ambient
   *  `ask` silently skips in RPC mode). Default: "no-approve" (the
   *  conservative floor; seat-level guidance/skills live in the seat's
   *  managed agent dir, which needs no project trust). */
  trustPosture?: "approve" | "no-approve";
  sleep?: (ms: number) => Promise<void>;
  /** Launch-attempt id minting (tests inject; defaults to randomUUID). */
  newLaunchId?: () => string;
  /** OPR.0.7.0.2: whether usage.pi_cost_facts is on, read at each launch (absent = off). */
  usageFactsEnabled?: () => boolean;
  /** OPR.0.7.0.2 K4: whether usage.pi_openrouter_charge is on, read at each launch (absent = off). */
  openRouterChargeEnabled?: () => boolean;
  /** #2456: with it, every guidance block this adapter writes is checked against the record and recorded; absent, the
   *  plain merge, as before. */
  managedBlockRecords?: ManagedBlockRecords;
}

export class PiRuntimeAdapter implements RuntimeAdapter {
  readonly runtime: RunnerRuntime = "pi";
  private tmux: TmuxAdapter;
  private seatLaunchEnvironment?: SeatLaunchEnvironment;
  private fs: PiAdapterFsOps;
  protected stateRoot: string;
  private stateRootForSession: (session: string) => string;
  private runnerEntryPath: string;
  private trustPosture: "approve" | "no-approve";
  private sleep: (ms: number) => Promise<void>;
  private newLaunchId: () => string;
  private usageFactsEnabled: () => boolean;
  private openRouterChargeEnabled: () => boolean;
  private managedBlockRecords: ManagedBlockRecords | undefined;

  constructor(deps: PiRuntimeAdapterDeps) {
    this.managedBlockRecords = deps.managedBlockRecords;
    this.usageFactsEnabled = deps.usageFactsEnabled ?? (() => false);
    this.openRouterChargeEnabled = deps.openRouterChargeEnabled ?? (() => false);
    this.tmux = deps.tmux;
    this.seatLaunchEnvironment = deps.seatLaunchEnvironment;
    this.fs = deps.fsOps;
    this.stateRoot = deps.stateRoot;
    this.stateRootForSession = deps.stateRootForSession ?? (() => this.stateRoot);
    this.runnerEntryPath = deps.runnerEntryPath;
    this.trustPosture = deps.trustPosture ?? "no-approve";
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
  }

  /** Resolve canonical identity and isolated state for a staged or committed occupant. */
  private runnerLocation(binding: NodeBinding): { sessionName: string; stateRoot: string } {
    const staged = this.runtime === "pi" && binding.runtimeSwitchFrom;
    const sessionName = staged ? staged.session : binding.tmuxSession!;
    return { sessionName, stateRoot: staged && binding.launchGeneration
      ? piAccountSwitchStateRoot(this.stateRoot, binding.launchGeneration) : this.stateRootForSession(sessionName) };
  }

  /** Resolve files in the occupant’s state directory rather than its temporary staging pane. */
  private bindingPaths(binding: NodeBinding) {
    const { sessionName, stateRoot } = this.runnerLocation(binding);
    return piSeatPaths(stateRoot, sessionName);
  }

  /** The pi-runner sidecar reader shape resume-token-capture consumes
   *  (deriveResumeToken's piRunnerStateStore dep). */
  readSessionFile(sessionName: string): { ok: true; sessionFile: string } | { ok: false; reason: string } {
    const state = this.readRunnerState(sessionName);
    if (state === null) {
      const { runnerStatePath } = piSeatPaths(this.stateRootForSession(sessionName), sessionName);
      return this.fs.exists(runnerStatePath)
        ? { ok: false, reason: "parse_error" }
        : { ok: false, reason: "missing_sidecar" };
    }
    if (!state.sessionFile) return { ok: false, reason: "missing_sidecar" };
    // OMP announces a future path before its first persisted turn. A path
    // that does not exist cannot be used as a resume token.
    if (this.runtime === "omp" && !this.fs.exists(state.sessionFile)) return { ok: false, reason: "missing_sidecar" };
    return { ok: true, sessionFile: state.sessionFile };
  }

  /** The seat's runner sidecar (null = absent or unparseable) and its sessions folder, with the
   *  runner entry path and state root this adapter launches with, for a reader that must tie the
   *  sidecar to the pane's live runner before trusting it. */
  readRunnerSidecar(sessionName: string): { state: PiRunnerState | null; sessionsDir: string; entryPath: string; stateRoot: string } {
    return {
      state: this.readRunnerState(sessionName),
      sessionsDir: piSeatPaths(this.stateRootForSession(sessionName), sessionName).sessionsDir,
      entryPath: this.runnerEntryPath,
      stateRoot: this.stateRootForSession(sessionName),
    };
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const sessionName = binding.tmuxSession;
    if (!sessionName) return results;
    const { agentDir } = this.bindingPaths(binding);
    const skillsDir = nodePath.join(agentDir, "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
  }

  /** Conflict detection must inspect this seat's copy, not a Claude sibling. */
  skillTargetPath(tmuxSession: string | null, effectiveId: string): string | null {
    if (!tmuxSession) return null;
    return nodePath.join(piSeatPaths(this.stateRootForSession(tmuxSession), tmuxSession).agentDir, "skills", effectiveId, "SKILL.md");
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const warnings: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      // The planner compares only SKILL.md for directory skills. Helpers can
      // change independently, so still copy the selected directory on reapply.
      const directorySkill = entry.category === "skill"
        && this.fs.exists(nodePath.join(entry.absolutePath, "SKILL.md"));
      if (entry.classification === "no_op" && !directorySkill) {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding, warnings)) {
          projected.push(entry.effectiveId);
        } else {
          skipped.push(entry.effectiveId);
        }
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    const warnings: string[] = [];
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content, file.orientation) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            // ADDITIVE context-file merge (Omnigent best-practice: never
            // replace Pi's default system prompt). Pi reads AGENTS.md from its
            // agent folder and from the managed cwd as context files.
            const targetPath = this.guidanceTarget(binding, warnings);
            if (!targetPath) continue; // not written through a link: not counted as delivered
            const merged = this.mergeGuidance(targetPath, file.path, content, warnings);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            if (!binding.tmuxSession) throw new Error("No tmux session bound — cannot resolve the Pi seat state dir");
            const { agentDir } = this.bindingPaths(binding);
            const targetDir = nodePath.join(agentDir, "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              // The runner reads pane stdin and forwards as RPC prompt (FR-3).
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) {
          failed.push({ path: file.path, error: (err as Error).message });
        }
      }
    }

    return { delivered, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    const wrapped = binding.launchWrapper?.length ? binding.launchWrapper : undefined;
    if (wrapped && (this.runtime !== "pi" || !this.seatLaunchEnvironment)) {
      return { ok: false, error: "launch_wrapper support unavailable; no agent started." };
    }
    if (!binding.tmuxSession) {
      return { ok: false, error: `No tmux session bound — cannot launch the ${this.runtime === "pi" ? "Pi" : "OMP"} harness` };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }

    let forkRef: string | undefined;
    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `${this.runtime} fork: ref.kind="${opts.forkSource.kind}" is not supported in v1; use ref.kind="native_id" with the parent session file path or session id`,
        };
      }
      forkRef = opts.forkSource.value?.trim();
      if (!forkRef) {
        return { ok: false, error: `${this.runtime} fork: forkSource.value is required (parent session file path or session id)` };
      }
    }

    if (opts.resumeToken) {
      // Validity floor before we type anything into the pane.
      const validation = validateResumeToken(this.runtime, opts.resumeToken);
      if (!validation.ok) {
        return { ok: false, error: `${this.runtime} resume: ${validation.error}` };
      }
      if (!this.fs.exists(opts.resumeToken)) {
        // Session file gone — the honest outcome is the caller's stop-and-ask
        // (awaiting-decision), never a silent fresh start (BR-6).
        return { ok: false, error: `${this.runtime} resume: the persisted session file no longer exists`, recovery: "retry_fresh", missingConversation: true };
      }
    }

    let resolvedWrapper: string[] | undefined;
    if (wrapped) {
      try {
        resolvedWrapper = this.seatLaunchEnvironment!.resolveLaunchWrapper(wrapped);
      } catch {
        return { ok: false, error: "launch_wrapper unavailable; no agent started." };
      }
    }

    const sessionName = binding.tmuxSession;
    const location = this.runnerLocation(binding);
    const paths = this.bindingPaths(binding);
    this.fs.mkdirp(paths.agentDir);
    this.fs.mkdirp(paths.sessionsDir);

    // Launch-attempt scoping (guard fold): overwrite any stale sidecar from a
    // prior runner instance with a pending record BEFORE the command is typed,
    // and only trust sidecar states stamped with THIS attempt's launchId.
    // The prior record is read FIRST so the durable catch-up cursor
    // (lastEntryId, FR-5) survives the reset.
    const launchId = this.newLaunchId();
    const prior = this.readRunnerState(location.sessionName, location.stateRoot);
    this.fs.writeFile(
      paths.runnerStatePath,
      JSON.stringify(buildPendingRunnerState(launchId, new Date().toISOString(), prior)),
    );

    const trust = this.runtime === "omp"
      ? (yoloEnabled(process.env, binding.launchPosture) ? "approve" : "no-approve")
      : piTrust(this.trustPosture, process.env, binding.launchPosture);
    const appliedLaunch = this.runtime === "omp"
      ? observeOmpApprovalMode(`--approval-mode ${trust === "approve" ? "yolo" : "always-ask"}`)
      : observePiResourceTrust(trust);
    const accountHome = binding.accountHome !== undefined ? binding.accountHome
      : binding.nodeId ? this.seatLaunchEnvironment?.accountHome(binding.nodeId, this.runtime) : undefined;
    const preparedHome = accountHome === null && binding.nodeId
      ? this.seatLaunchEnvironment?.accountHome(binding.nodeId, this.runtime, true) : accountHome;
    const cmd = buildPiRunnerCommand({
      accountHome: preparedHome ?? undefined,
      runtime: this.runtime,
      runnerEntryPath: this.runnerEntryPath,
      sessionName: location.sessionName,
      stateRoot: location.stateRoot,
      cwd: binding.cwd,
      model: binding.model,
      // The seat's resolved effort, sent as Pi's --thinking; OMP unchanged.
      thinking: this.runtime === "pi" ? binding.effort : undefined,
      // OPR.0.4.8.2: Pi RESOURCE TRUST (not a permission policy). YOLO forces `approve` on every
      // seat; otherwise the configured posture. Same decision used on the restore path (pi-resume).
      trust,
      sessionFile: opts.resumeToken,
      forkRef,
      launchId,
      usageFacts: this.runtime === "pi" && this.usageFactsEnabled(),
      openRouterCharge: this.runtime === "pi" && this.openRouterChargeEnabled(),
      ...(resolvedWrapper ? { launchWrapper: resolvedWrapper } : {}),
    });

    const fallback = cmd;
    const command = this.runtime === "pi" && this.seatLaunchEnvironment
      ? await this.seatLaunchEnvironment.command(sessionName, cmd, { nodeId: binding.nodeId, generation: binding.launchGeneration, runtime: this.runtime, accountHome })
      : fallback;
    // Stage long commands without leaving a shell above the live runner.
    let textResult = await this.tmux.sendShellCommand(sessionName, command, undefined, { stageIfLong: true, execInScript: true });
    if (!textResult.ok && textResult.code === "launch_path_too_long" && command !== fallback && accountHome === undefined) {
      textResult = await this.tmux.sendShellCommand(sessionName, fallback, undefined, { stageIfLong: true, execInScript: true });
    }
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }

    // The runner writes the sidecar after its first successful get_state;
    // that sidecar (not pane content) is the token source of truth (FR-5).
    const state = await this.waitForRunnerReady(location.sessionName, launchId, location.stateRoot);
    if (!state.ok) return state.failure;

    const sessionFile = state.value.sessionFile;
    if (!sessionFile) {
      return { ok: false, error: `${this.runtime} launch: the runner became ready but reported no session file` };
    }
    if (this.runtime === "omp" && opts.resumeToken && sessionFile !== opts.resumeToken) {
      // An exact OMP resume must continue the requested history; a runner
      // that came up on any other file started a different session. Same
      // contract as the separate resume adapter's verifyResume.
      return { ok: false, error: "omp resume: the runner is ready but does not report the requested session file" };
    }
    if (forkRef && sessionFile === forkRef) {
      // The adapter contract requires the NEW post-fork token, never the
      // parent's (runtime-adapter.ts fork rule).
      return { ok: false, error: `${this.runtime} fork: the runner reported the parent session file instead of the post-fork child` };
    }
    const validation = validateResumeToken(this.runtime, sessionFile);
    if (!validation.ok) {
      return { ok: false, error: `${this.runtime} launch: the runner reported a malformed session file (${validation.error})` };
    }

    // OMP lazily creates its JSONL on the first persisted turn. Readiness
    // is real, but until then there is no history to resume after a reboot.
    if (this.runtime === "omp" && !this.fs.exists(validation.token)) return { ok: true, appliedLaunch };
    return { ok: true, resumeToken: validation.token, resumeType: `${this.runtime}_session_file`, appliedLaunch };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session not responsive" };
    }
    // Guard fold (stale artifacts): a sidecar or scrollback marker can outlive
    // the runner process, so a ready signal counts ONLY while the pane's
    // foreground process is not back at a shell (a dead runner leaves the
    // pane at the shell; READY scrollback and a stale ready sidecar do not
    // make a stopped seat ready).
    const paneCommand = (await this.tmux.getPaneCommand(binding.tmuxSession)) ?? "";
    const atShell = SHELL_COMMANDS.has(paneCommand);
    const state = this.readRunnerState(this.runnerLocation(binding).sessionName, this.runnerLocation(binding).stateRoot);
    if (state?.exited) {
      return { ready: false, reason: `${this.runtime}-runner exited (code ${state.exited.code ?? "unknown"})`, code: "runner_exited" };
    }
    if (state?.ready) {
      if (atShell) {
        return { ready: false, reason: `${this.runtime}-runner sidecar says ready but the pane is back at a shell (runner process gone)`, code: "runner_exited" };
      }
      return { ready: true };
    }
    // Runner-authored pane marker as the secondary signal (FR-2) — still the
    // runner's own output, never Pi TUI heuristics; same foreground guard.
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    const marker = this.runtime === "omp" ? "[omp-runner]" : "[pi-runner]";
    if (paneContent.includes(`${marker} ERROR`)) {
      return { ready: false, reason: `${this.runtime}-runner reported an error in the pane`, code: "runner_error" };
    }
    if (paneContent.includes(`${marker} EXITED`)) {
      return { ready: false, reason: `${this.runtime}-runner exited`, code: "runner_exited" };
    }
    if (paneContent.includes(`${marker} READY`)) {
      if (atShell) {
        return { ready: false, reason: "READY marker is stale scrollback; the pane is back at a shell", code: "runner_exited" };
      }
      return { ready: true };
    }
    return { ready: false, reason: `${this.runtime}-runner has not reported ready yet`, code: "awaiting_runtime" };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private readRunnerState(sessionName: string, stateRoot = this.stateRootForSession(sessionName)): PiRunnerState | null {
    const { runnerStatePath } = piSeatPaths(stateRoot, sessionName);
    if (!this.fs.exists(runnerStatePath)) return null;
    try {
      return parsePiRunnerState(this.fs.readFile(runnerStatePath));
    } catch {
      return null;
    }
  }

  private async waitForRunnerReady(
    sessionName: string,
    launchId: string,
    stateRoot = this.stateRootForSession(sessionName),
  ): Promise<{ ok: true; value: PiRunnerState } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = 250;
    const attempts = 60; // ~15s: runner boot + pi spawn + first get_state
    for (let attempt = 0; attempt < attempts; attempt++) {
      const state = this.readRunnerState(sessionName, stateRoot);
      // Launch-attempt scoping: only THIS attempt's sidecar states count.
      // Stale ready/exited records from prior instances are ignored, and
      // stale pane markers in scrollback are never consulted here — the
      // launch-scoped sidecar is authoritative (the runner writes a pending
      // record immediately at startup and exited on death).
      if (state?.launchId === launchId) {
        if (state.exited) {
          const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
          return {
            ok: false,
            failure: {
              ok: false,
              error: `${this.runtime} launch failed: the runner exited (code ${state.exited.code ?? "unknown"})`,
              recovery: "attention_required",
              evidence: paneContent.split("\n").slice(-12).join("\n"),
            },
          };
        }
        if (state.ready) return { ok: true, value: state };
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      failure: {
        ok: false,
        error: `${this.runtime} launch: timed out waiting for the runner to report ready`,
        recovery: "attention_required",
      },
    };
  }

  /** #875: a Pi seat's managed guidance goes into its own agent folder's AGENTS.md, which Pi loads before the repository's
   *  (PI_CODING_AGENT_DIR is that folder), so the person's tracked repository AGENTS.md is never written. The repository
   *  file stays when there's no session yet, or when the folder or its AGENTS.md is a link: through a link, other sessions
   *  (a person's own Pi home, a shared file) would read this rig's guidance. */
  guidanceFileFor(binding: NodeBinding): { file: string | null; note?: string } {
    if (!binding.tmuxSession) return { file: null };
    const file = nodePath.join(this.bindingPaths(binding).agentDir, "AGENTS.md");
    const linked = guidanceFileSharedByLink(file, (path) => this.fs.linkInfo?.(path) ?? null);
    return linked ? { file: null, note: `${this.runtime}: ${linked} is a link, so this seat's managed guidance stays in its repository AGENTS.md` } : { file };
  }

  /** The file this launch merges guidance into: the one its startup chose (guidanceFileFor, or a restore's saved choice),
   *  else the repository AGENTS.md in the managed cwd. Null when a chosen file has since become a link (#2432): nothing is
   *  written through it, and nothing falls back to the repository file. */
  private guidanceTarget(binding: NodeBinding, warnings: string[]): string | null {
    if (!binding.guidanceFile) return nodePath.join(binding.cwd, "AGENTS.md");
    const linked = guidanceFileSharedByLink(binding.guidanceFile, (path) => this.fs.linkInfo?.(path) ?? null);
    if (!linked) return binding.guidanceFile;
    warnings.push(`${this.runtime}: ${linked} is now a link, so this seat's managed guidance wasn't written to ${binding.guidanceFile}, which other sessions could read`);
    return null;
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding, warnings: string[]): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = this.guidanceTarget(binding, warnings);
      if (!targetPath) return false;
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content, warnings, entry.absolutePath);
    }

    if (entry.category === "skill") {
      if (!binding.tmuxSession) return false;
      const { agentDir } = this.bindingPaths(binding);
      const targetDir = nodePath.join(agentDir, "skills", entry.effectiveId);
      this.fs.mkdirp(targetDir);
      let isDir = false;
      if (this.fs.listFiles) {
        try {
          isDir = this.fs.listFiles(entry.absolutePath).length > 0;
        } catch {
          // File-shaped sources make the production listFiles (recursive
          // fs.readdirSync walk) throw ENOTDIR — treat the entry as file-shaped.
          isDir = false;
        }
      }
      if (isDir && this.fs.listFiles) {
        for (const file of this.fs.listFiles(entry.absolutePath)) {
          const dest = nodePath.join(targetDir, file);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.fs.writeFile(dest, this.fs.readFile(nodePath.join(entry.absolutePath, file)));
          this.preserveMode(nodePath.join(entry.absolutePath, file), dest);
        }
      } else {
        this.fs.writeFile(
          nodePath.join(targetDir, nodePath.basename(entry.absolutePath)),
          this.fs.readFile(entry.absolutePath),
        );
        this.preserveMode(entry.absolutePath, nodePath.join(targetDir, nodePath.basename(entry.absolutePath)));
      }
      return true;
    }

    // Plugins / subagents / runtime resources have no Pi projection target at
    // MVP (PRD §7 out-of-scope) — an honest skip, never a misdelivery.
    return false;
  }

  private preserveMode(source: string, target: string): void {
    if (this.fs.statMode && this.fs.chmod) this.fs.chmod(target, this.fs.statMode(source) & 0o777);
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string, warnings: string[], sourcePath?: string): boolean {
    // Mirrors the Claude/Codex adapters: per-seat `rig-role` content collides
    // across pod-mates when merged into a shared cwd file; it is delivered via
    // send_text instead. See ADR-0006.
    if (isPerSeatRoleGuidance(blockId, sourcePath)) {
      console.log(
        `[openrig] skip: effectiveId is ${blockId}, a seat's own role; per-seat delivery via send_text path required (target=${targetPath})`
      );
      const warning = perSeatRoleSkipWarning(blockId, targetPath);
      if (warning) warnings.push(warning);
      return false;
    }
    // #2456: a block a person edited since OpenRig wrote it is kept and named, not counted as merged.
    return writeManagedGuidanceBlock(this.fs, targetPath, blockId, content, {
      records: this.managedBlockRecords, sourcePath, warnings,
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
  }
}
