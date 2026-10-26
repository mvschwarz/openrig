import { withManagedRestoreReads, type RestoreReadPolicy } from "../domain/managed-restore-read-access.js";
import { operationalLaunchArgs } from "./kernel-authority.js";
import { claudeSeatTokenFallbackNotice } from "../domain/claude-seat-token.js";
import nodePath from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import { claudePostureFlag, claudeClassicRendererEnvPrefix } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult, ReadinessOptions,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { resumeProbeEvidence } from "../domain/native-resume-probe-evidence.js";
import { resolveReadinessTimeoutMs } from "../domain/readiness-timeout.js";
import { subtreeNamesClaudeExecutable, claudeCommandSessionToken, listNativeProcesses, observeClaudeDelivery, observeClaudePaneProcess, observeClaudePaneRuntime, observeCodexPaneProcess, verifyClaudePaneProcess, verifyCodexPaneProcess, verifyPaneIdleShell, witnessedClaudeVersionLabel, type ClaudeLaunchedProcess, type NativeProcessLister, type VersionLabelWitnessWait } from "../domain/native-process-lineage.js";
import { isPerSeatRoleGuidance, mergeManagedBlock, perSeatRoleSkipWarning, DEFAULT_CLAUDE_MANAGED_BLOCK_FILE, type ClaudeManagedBlockFile } from "../domain/managed-blocks.js";
import { claudeResumeLaunchEnv, claudeResumeLaunchPrefix } from "./claude-resume-launch.js";
import { shellQuote } from "./shell-quote.js";
import { validateClaudeActivityHookDelivery, claudeActivityRelayPath, CLAUDE_ACTIVITY_RELAY_RELATIVE_PATH, parseManagedClaudeNodeCommand } from "../domain/claude-activity-hooks.js";
import { isFilesystemRoot } from "../domain/cwd-resolution.js";
import { observeClaudePermission } from "../domain/permission-drift.js";
import { unresolvedClaudePermissionModes } from "../domain/native-permission-selection.js";
import type { ClaudeManagedLaunch } from "../domain/claude-managed-launch.js";
import { contextUsageDirectory, providerUsageDirectory } from "../domain/telemetry-state-paths.js";
import { seatLaunchAdditionArgs } from "../domain/seat-launch-additions.js";
import { recordSeatSkillWrite, seatPluginSkillsLossNote, seatProjectionComplete, seatSkillWriteRefusal } from "../domain/seat-skill-storage.js";

export interface ClaudeAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  copyFile(src: string, dest: string): void;
  listFiles?(dirPath: string): string[];
  /** Source file permission bits (for mode-preserving projection). Optional: mode preservation is a no-op if absent. */
  statMode?(path: string): number;
  /** Apply permission bits to a file (for mode-preserving projection). Optional: no-op if absent. */
  chmod?(path: string, mode: number): void;
  /** List files in a directory (for session token capture). */
  readdir?(dirPath: string): string[];
  /** User home directory (for session file lookup). */
  homedir?: string;
}

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

/**
 * Claude Code runtime adapter. Projects resources to .claude/ targets
 * and delivers startup files via guidance merge, skill install, or tmux send-text.
 */
export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly runtime = "claude-code";
  private tmux: TmuxAdapter;
  private seatLaunchEnvironment?: SeatLaunchEnvironment;
  private fs: ClaudeAdapterFsOps;
  private sessionIdFactory: () => string;
  private sleep: (ms: number) => Promise<void>;
  private stateDir: string | null;
  private restoreReadPolicy: (() => RestoreReadPolicy | null) | null;
  private collectorAssetPath: string | null;
  private nodeExecutable: string;
  private autoDriveProviderPrompts: boolean;
  private listProcesses?: NativeProcessLister;
  private resolvePermissionMode?: (nodeId: string) => string | undefined;
  private readinessTimeoutMs?: number;
  private autoLaunches = new Map<string, { binding: NodeBinding; token: string; freshInPlace?: boolean; executable?: string; scriptLaunch?: boolean; fingerprint?: string; process?: ClaudeLaunchedProcess }>();
  readonly claudeManagedLaunch?: ClaudeManagedLaunch;
  private activityRelayPath: string | null;
  private claudeHooksManifestPath: string | null;
  /** P20 — called after a projected file is written to a target, so the manifest
   *  records what we last wrote (→ operator-vs-stale discrimination). No-op by default. */
  private recordProjection: (targetPath: string, content: string) => void;

  constructor(deps: {
    tmux: TmuxAdapter;
    seatLaunchEnvironment?: SeatLaunchEnvironment;
    fsOps: ClaudeAdapterFsOps;
    sessionIdFactory?: () => string;
    sleep?: (ms: number) => Promise<void>;
    stateDir?: string;
    /** The compaction settings the restore reads from, so the launch grants those files too. */
    restoreReadPolicy?: () => RestoreReadPolicy | null;
    collectorAssetPath?: string;
    /** Interpreter used to write generated Claude commands; defaults to this daemon runtime. */
    nodeExecutable?: string;
    autoDriveProviderPrompts?: boolean;
    listProcesses?: NativeProcessLister;
    /** #86 — the seat's persisted managed permission mode (NativePermissionStore.resolve), undefined when
     *  unmanaged; throws when it can't be read. Absent → every seat counts as managed for the version-label witness. */
    resolvePermissionMode?: (nodeId: string) => string | undefined;
    /** Bound on a slow resume's wait, from the launch (default: runtime.readiness_timeout_seconds). */
    readinessTimeoutMs?: number;
    claudeManagedLaunch?: ClaudeManagedLaunch;
    /** DI source of the activity-relay.cjs asset (parity with the Codex adapter). */
    activityRelayPath?: string;
    /** DI source of the canonical claude.json hooks manifest — the event vocabulary
     *  is derived (filtered to relay events) from it, not a parallel constant. */
    claudeHooksManifestPath?: string;
    /** P20 — record-at-apply hook (startup wires it to the projection manifest store).
     *  Absent → no-op (the manifest stays empty → discrimination safe-degrades to P17). */
    recordProjection?: (targetPath: string, content: string) => void;
  }) {
    this.tmux = deps.tmux;
    this.seatLaunchEnvironment = deps.seatLaunchEnvironment;
    this.fs = deps.fsOps;
    this.sessionIdFactory = deps.sessionIdFactory ?? randomUUID;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.stateDir = deps.stateDir ?? null;
    this.restoreReadPolicy = deps.restoreReadPolicy ?? null;
    this.collectorAssetPath = deps.collectorAssetPath ?? null;
    this.nodeExecutable = deps.nodeExecutable ?? process.execPath;
    this.autoDriveProviderPrompts = deps.autoDriveProviderPrompts ?? false;
    this.listProcesses = deps.listProcesses;
    this.resolvePermissionMode = deps.resolvePermissionMode;
    this.readinessTimeoutMs = deps.readinessTimeoutMs;
    this.claudeManagedLaunch = deps.claudeManagedLaunch;
    this.activityRelayPath = deps.activityRelayPath ?? null;
    this.claudeHooksManifestPath = deps.claudeHooksManifestPath ?? null;
    this.recordProjection = deps.recordProjection ?? (() => {});
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = binding.seatSkillsRoot ?? nodePath.join(binding.cwd, ".claude", "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const warnings: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }

      try {
        const didProject = this.projectEntry(entry, binding.cwd, binding.claudeManagedBlockFile ?? DEFAULT_CLAUDE_MANAGED_BLOCK_FILE, warnings, binding.seatSkillsRoot, binding.seatSkillsRefused);
        if (didProject) {
          projected.push(entry.effectiveId);
        } else {
          skipped.push(entry.effectiveId);
        }
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    // Activity-hook reconciliation is driven from this ALWAYS-RUN seam (not a
    // per-entry projection): a profile that REMOVES the resource emits no entry,
    // so the strip/disable branch must fire off the plan's ABSENCE — not off an
    // entry — for durable disable to be production-reachable. Exactly one call.
    const activityEntries = plan.entries.filter(
      (e) => e.category === "runtime_resource" && e.resourceType === "claude_activity_hooks",
    );
    let activityOutcome: ActivityHookOutcome = { changed: false, delivered: false, sourceMissing: false, manifestUnavailable: false, settingsUnparseable: false };
    try {
      activityOutcome = this.reconcileClaudeActivityHooks(binding.cwd, activityEntries.length > 0);
    } catch (err) {
      // #226: delivery at '/' is still attempted (it works where '/' is writable); when it fails there, say why.
      // A binding without a cwd (startup bootstraps the stored node's selection) gets the plain warning.
      const atRoot = binding.cwd && isFilesystemRoot(binding.cwd)
        ? ` (cwd '${binding.cwd}' resolves to the filesystem root, not a project workspace)`
        : "";
      console.error(`[openrig] claude activity-hook reconcile warning${atRoot}: ${(err as Error).message}`);
      activityOutcome = { changed: false, delivered: false, sourceMissing: false, manifestUnavailable: false, settingsUnparseable: false };
    }
    // Never claim a resource as PROJECTED when delivery could not happen (missing
    // relay source or a fail-closed malformed settings file): demote to skipped so
    // no false projected claim + no dangling hooks are reported as success.
    if (activityEntries.length > 0 && !activityOutcome.delivered) {
      for (const e of activityEntries) {
        const idx = projected.indexOf(e.effectiveId);
        if (idx >= 0) projected.splice(idx, 1);
        if (!skipped.includes(e.effectiveId)) skipped.push(e.effectiveId);
      }
    }

    return { projected, skipped, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding, sendInteractiveText?: (text: string) => Promise<void>): Promise<StartupDeliveryResult> {
    try { this.ensureManagedBootstrap(binding); } catch (err) {
      console.error(`[openrig] claude bootstrap warning: ${(err as Error).message}`);
    }

    // Best-effort: provision context collector for managed Claude sessions
    try { this.ensureContextCollector(binding); } catch (err) {
      // Log but don't fail — collector provisioning is best-effort
      console.error(`[openrig] context collector provisioning warning: ${(err as Error).message}`);
    }

    const warnings: string[] = [];
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? this.detectDeliveryHint(file.path, content, file.orientation) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, binding.claudeManagedBlockFile ?? DEFAULT_CLAUDE_MANAGED_BLOCK_FILE);
            const merged = this.mergeGuidance(targetPath, file.path, content, warnings);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.seatSkillsRoot ?? nodePath.join(binding.cwd, ".claude", "skills"), nodePath.basename(nodePath.dirname(file.absolutePath)));
            const skillTarget = nodePath.join(targetDir, nodePath.basename(file.path));
            // OPR.0.7.0.13: never write through a link out of the seat's storage.
            const refusal = binding.seatSkillsRoot ? binding.seatSkillsRefused ?? seatSkillWriteRefusal(binding.seatSkillsRoot, skillTarget) : undefined;
            if (refusal) { warnings.push(`skill_install: ${refusal}`); continue; }
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(skillTarget, content);
            if (binding.seatSkillsRoot) recordSeatSkillWrite(binding.seatSkillsRoot, skillTarget, file.absolutePath, content);
            // P20 — record what we just wrote so the next projection can tell a
            // stale re-projection (safe overwrite) from an operator edit (protect).
            this.recordProjection(skillTarget, content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              if (sendInteractiveText) {
                await sendInteractiveText(content);
                break;
              }
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
    opts: { name: string; resumeToken?: string; forkSource?: import("../domain/runtime-adapter.js").ForkSource; freshInPlace?: boolean },
  ): Promise<HarnessLaunchResult> {
    binding = { ...binding };
    this.autoLaunches.delete(binding.nodeId);
    opts = { ...opts, ...(opts.forkSource ? { forkSource: { ...opts.forkSource } } : {}) };
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch Claude Code harness" };
    }

    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }

    // OPR.0.4.8.2: the acceptEdits floor by default; YOLO (opt-in) swaps in the full-bypass flag.
    // The SAME decision (claudePostureFlag) is used on the restore path (claude-resume.ts).
    // OPR.0.4.8.3 Seam B: a per-seat resolved policy posture (binding.launchPosture) overrides env.
    let managed: Awaited<ReturnType<ClaudeManagedLaunch["prepare"]>> | undefined;
    if (binding.permissionMode !== undefined) {
      try {
        if (!this.claudeManagedLaunch) await unresolvedClaudePermissionModes();
        managed = await this.claudeManagedLaunch!.prepare({ nodeId: binding.nodeId, cwd: binding.cwd,
          session: binding.tmuxSession, pane: binding.tmuxPane, generation: binding.launchGeneration,
          ...(binding.runtimeSwitchFrom ? { runtimeSwitch: { fromRuntime: binding.runtimeSwitchFrom.runtime, session: binding.runtimeSwitchFrom.session,
            pane: binding.runtimeSwitchFrom.pane, generation: binding.runtimeSwitchFrom.generation } } : {}) }, binding.permissionMode);
      } catch (error) { return { ok: false, error: (error as Error).message }; }
    }
    // A seat's own subscription token: the managed launch carries it; the classic launch gets its step in the staged
    // subshell. A launch that can't apply it still starts, and says so.
    const seatToken = managed ? null : this.claudeManagedLaunch?.seatTokenLaunch?.(binding.nodeId) ?? null;
    const tokenWarnings: string[] = [...(managed?.warnings ?? seatToken?.warnings ?? [])];
    const session = binding.tmuxSession;
    const sendClassic = async (cmd: string) => {
      if (!this.seatLaunchEnvironment) {
        if (seatToken) tokenWarnings.push(this.claudeManagedLaunch?.tokenNotApplied?.(binding.nodeId, seatToken.ref, "this launch path can't run the token step") ?? claudeSeatTokenFallbackNotice(seatToken.ref, "this launch path can't run the token step"));
        return this.tmux.sendText(session, cmd);
      }
      const staged = await this.seatLaunchEnvironment.command(session, cmd, { nodeId: binding.nodeId, generation: binding.launchGeneration,
        runtime: this.runtime, ...(seatToken ? { claudeTokenStep: seatToken.step } : {}) });
      if (seatToken && !staged.includes(seatToken.step)) {
        tokenWarnings.push(this.claudeManagedLaunch?.tokenNotApplied?.(binding.nodeId, seatToken.ref, "the seat's pane shell can't run the token step") ?? claudeSeatTokenFallbackNotice(seatToken.ref, "the seat's pane shell can't run the token step"));
      }
      return this.tmux.sendShellCommand(session, staged, undefined, { sourceInPane: true });
    };
    const launchNotes = () => (tokenWarnings.length ? { warnings: [...tokenWarnings] } : {});
    const posture = claudePostureFlag(process.env, binding.launchPosture, binding.permissionMode);
    const appliedLaunch = observeClaudePermission(posture);
    const permissionArgs = (nativeSessionId: string) => withManagedRestoreReads(operationalLaunchArgs(this.runtime, binding), {
      openrigHome: this.stateDir, session: opts.name, cwd: binding.cwd, nativeSessionId, ...(this.restoreReadPolicy?.() ?? {}),
    });
    const permissionArg = (args: string[]) => posture + args.map(arg => ` ${shellQuote(arg)}`).join("");
    // OPR.0.5.3.1: classic-renderer env prefix (default on) → native scrollback for every
    // managed launch path (fresh/resume/fork). "" when overridden off → byte-identical command.
    const rendererPrefix = claudeClassicRendererEnvPrefix(process.env);

    // 51-07: a per-agent model declared in the spec (member.model ?? profile ?? defaults, resolved
    // onto binding.model at instantiate) is emitted as `--model <x>` on the launch command. Absent →
    // empty string → the command is byte-identical (regression pin). ADDITIVE ONLY: this sits beside
    // the permissionMode/posture flag but never alters it (the D1 model-only fence). Mirrors codex's
    // modelArg (codex-runtime-adapter.ts). NOTE: the restore path (claude-resume.ts) + the native
    // resume-cmd builder are the named A2 restore-parity follow-on, not this atom.
    const model = binding.model?.trim();
    const modelArg = model ? ` --model ${shellQuote(model)}` : "";
    const effort = binding.effort?.trim();
    const effortArg = effort ? ` --effort ${shellQuote(effort)}` : "";
    const advisor = binding.advisor?.trim();
    const advisorArg = advisor ? ` --advisor ${shellQuote(advisor)}` : "";
    // OPR.0.7.0.9: the seat's own additions, after the model, effort and Advisor and before the identity options.
    const additionArgs = seatLaunchAdditionArgs(binding.launchAdditions);
    const additionArg = additionArgs.map((arg, index) => ` ${index % 2 === 0 ? arg : shellQuote(arg)}`).join(""); // flag, value pairs

    // Fork branch: `claude --resume <parent> --fork-session --session-id <fork> --name <seat>`
    // (Claude Code 2.0.73 or later). The fork's own id is chosen here, like a fresh launch's,
    // so the parent token is NEVER persisted onto the new seat record (identity-honesty
    // bedrock) and the fork's argv names the conversation it runs.
    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `claude-code fork: ref.kind="${opts.forkSource.kind}" is not supported in v1; use ref.kind="native_id" with the prior conversation's session id`,
        };
      }
      const parentId = opts.forkSource.value?.trim();
      if (!parentId) {
        return { ok: false, error: "claude-code fork: forkSource.value is required (parent native_id)" };
      }
      const forkSessionId = this.sessionIdFactory();
      const launchArgs = permissionArgs(forkSessionId);
      const permissionMode = permissionArg(launchArgs);
      const cmd = managed ? managed.command(["--permission-mode", binding.permissionMode!, ...launchArgs, ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), ...(advisor ? ["--advisor", advisor] : []), ...additionArgs,
        "--resume", parentId, "--fork-session", "--session-id", forkSessionId, "--name", opts.name])
        // The non-managed command text is parsed by the pane shell, so the
        // parent id needs the same quoting as --model/--effort above (and as
        // the codex fork path) — a hostile id must not leave --resume.
        : `${rendererPrefix}claude ${permissionMode}${modelArg}${effortArg}${advisorArg}${additionArg} --resume ${shellQuote(parentId)} --fork-session --session-id ${forkSessionId} --name ${opts.name}`;
      const textResult = managed ? await this.tmux.sendShellCommand(binding.tmuxSession, cmd, managed.assertCurrent)
        : await sendClassic(cmd);
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
      }
      const enterResult = managed || this.seatLaunchEnvironment ? { ok: true as const } : await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
      if (!enterResult.ok) {
        return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
      }
      // As with a fresh launch, nothing is read back from Claude's session files: a same-name
      // file can belong to an earlier occupant or another seat sharing the config directory.
      return { ok: true, resumeToken: forkSessionId, resumeType: "claude_id", appliedLaunch, ...launchNotes() };
    }

    const generatedSessionId = opts.resumeToken ? null : this.sessionIdFactory();
    const launchArgs = permissionArgs(opts.resumeToken ?? generatedSessionId!);
    const permissionMode = permissionArg(launchArgs);
    const cmd = managed ? managed.command(["--permission-mode", binding.permissionMode!, ...launchArgs, ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), ...(advisor ? ["--advisor", advisor] : []), ...additionArgs,
      ...(opts.resumeToken ? ["--resume", opts.resumeToken] : ["--session-id", generatedSessionId!]), "--name", opts.name],
      opts.resumeToken ? claudeResumeLaunchEnv(opts.resumeToken) : undefined) : opts.resumeToken
      ? `${claudeResumeLaunchPrefix(opts.resumeToken)}${rendererPrefix}claude ${permissionMode}${modelArg}${effortArg}${advisorArg}${additionArg} --resume ${shellQuote(opts.resumeToken)} --name ${opts.name}`
      : `${rendererPrefix}claude ${permissionMode}${modelArg}${effortArg}${advisorArg}${additionArg} --session-id ${generatedSessionId} --name ${opts.name}`;

    const textResult = managed ? await this.tmux.sendShellCommand(binding.tmuxSession, cmd, managed.assertCurrent)
      : await sendClassic(cmd);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }
    // Send Enter to execute
    const enterResult = managed || this.seatLaunchEnvironment ? { ok: true as const } : await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
    if (!enterResult.ok) {
      return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
    }

    const launch = { binding, token: opts.resumeToken ?? generatedSessionId!,
      freshInPlace: opts.freshInPlace === true && !opts.resumeToken, executable: managed?.executable,
      scriptLaunch: managed?.executableIsScript } as
      { binding: NodeBinding; token: string; freshInPlace?: boolean; executable?: string; scriptLaunch?: boolean; fingerprint?: string; process?: ClaudeLaunchedProcess };
    this.autoLaunches.set(binding.nodeId, launch);
    if (opts.resumeToken) {
      const verification = await this.verifyResumeLaunch(binding);
      // The process readiness pinned first, if it observed one: the caller records it, not a later read.
      const launchedProcess = launch.process ? { launchedProcess: { ...launch.process } } : {};
      if (!verification.ok) return { ...verification, ...launchedProcess };
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "claude_id", appliedLaunch, ...launchedProcess, ...launchNotes() };
    }

    // Fresh launches already have an explicit --session-id. A same-name file
    // can belong to another seat sharing the Claude config directory.
    return { ok: true, resumeToken: generatedSessionId!, resumeType: "claude_id", appliedLaunch, ...launchNotes() };
  }

  async checkReady(binding: NodeBinding, options?: ReadinessOptions): Promise<ReadinessResult> {
    binding = { ...binding };
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session not responsive" };
    }

    const paneCommand = await this.tmux.getPaneCommand(binding.tmuxSession);
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    const historyProbe = await this.assessManagedProbe(binding, paneCommand, paneContent, options);
    const probe = await this.assessFreshInPlaceProbe(binding, paneCommand, historyProbe);

    // A script-launched Claude reads as `sh` until the script hands over the foreground, so the label alone
    // is not a return to a shell. Say so only for a proven idle shell (the rule Codex's checkReady uses).
    if (probe.code === "returned_to_shell"
      && !await verifyPaneIdleShell({ target: binding.tmuxSession, tmux: this.tmux, listProcesses: this.listProcesses })) {
      return {
        ready: false,
        reason: "The pane shows a shell that is not a proven idle shell; a launch script may still be starting Claude.",
        code: "awaiting_runtime",
      };
    }

    if (probe.status === "resumed") return "provedWithoutLaunch" in probe ? { ready: true, provedWithoutLaunch: true } : { ready: true };
    return { ready: false, reason: probe.detail, code: probe.code };
  }

  /** Best-effort public seam for tmux-bound Claude sessions adopted outside the launch path. */
  ensureContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void {
    this.provisionContextCollector(binding);
  }

  /** Best-effort public seam for user-scope Claude bootstrap used by managed sessions. */
  ensureManagedBootstrap(binding: { nodeId?: string; cwd?: string | null; tmuxSession?: string | null; permissionMode?: NodeBinding["permissionMode"] }): void {
    this.provisionManagedBootstrap(binding);
  }

  // -- Private helpers --

  /** #86: only a launch binding carries permissionMode, so the seat's persisted selection decides for every other
   *  caller. Unmanaged needs both to say so; a missing or unreadable selection counts as managed. */
  private isUnmanaged(binding: NodeBinding): boolean {
    if (binding.permissionMode !== undefined || !this.resolvePermissionMode) return false;
    try { return this.resolvePermissionMode(binding.nodeId) === undefined; } catch { return false; }
  }

  /** A fresh in-place launch keeps the retiree's scrollback. Qualify a history-based ready result
   * with the current frame, only for the exact launch that requested it. Unavailable observations
   * retain the old admission (including its ambiguity); visible gates and conflicting identity do not. */
  private async assessFreshInPlaceProbe(
    binding: NodeBinding, paneCommand: string | null,
    historyProbe: ReturnType<typeof assessNativeResumeProbe>,
  ) {
    const launch = this.autoLaunches.get(binding.nodeId);
    if (historyProbe.status !== "resumed" || !launch?.freshInPlace || !binding.tmuxPane || !binding.tmuxSession
      || launch.binding.id !== binding.id || launch.binding.tmuxPane !== binding.tmuxPane
      || launch.binding.tmuxSession !== binding.tmuxSession
      || launch.binding.launchGeneration !== binding.launchGeneration) return historyProbe;

    let screen: string | null = null;
    try { screen = await this.tmux.capturePaneScreen(binding.tmuxPane); } catch { /* unavailable */ }
    // Missing process evidence is unknown, not a conflicting recipient. Reuse the launch observer's
    // positive conflict distinction without requiring process proof for ordinary ready frames.
    let occupant: "own" | "another" | "unknown" | "absent" = "unknown";
    try { occupant = await this.paneOccupant(binding, false, { positiveConflictOnly: true }); } catch { /* unavailable */ }
    if (this.autoLaunches.get(binding.nodeId) !== launch) return {
      status: "inconclusive" as const, code: "awaiting_runtime", detail: "The fresh launch changed during readiness observation.",
    };
    if (occupant === "another") return {
      status: "inconclusive" as const, code: "claude_launch_identity_conflict",
      detail: "A different runtime identity occupies the fresh launch's pane.",
    };
    if (!screen?.trim()) return historyProbe;
    const current = await this.assessManagedProbe(binding, paneCommand, screen);
    if (this.autoLaunches.get(binding.nodeId) !== launch) return {
      status: "inconclusive" as const, code: "awaiting_runtime", detail: "The fresh launch changed during readiness observation.",
    };
    // A shell prompt can also start with ❯. Keep the headerless fallback only when process
    // evidence cannot rule Claude out; a readable shell/script-only pane uses the current result.
    const withIdentity = assessNativeResumeProbe({ runtime: "claude-code", paneCommand, paneContent: screen,
      claudeAutoIdentityVerified: true, claudeResumeIdentityVerified: true });
    return withIdentity.status === "resumed" && occupant !== "absent" ? historyProbe : current;
  }

  private async assessManagedProbe(binding: NodeBinding, paneCommand: string | null, paneContent: string, options?: ReadinessOptions, witnessWait?: VersionLabelWitnessWait) {
    const input = { runtime: "claude-code", paneCommand, paneContent };
    const probe = assessNativeResumeProbe(input);
    // #86: an unmanaged native install's version label reads as `claude` once its OS executable is witnessed. The
    // witness runs only when the label would change the result; a managed seat keeps its exact proof below.
    const asClaude = assessNativeResumeProbe({ ...input, paneCommand: "claude" });
    if (probe.status !== "resumed" && asClaude.status === "resumed" && this.isUnmanaged(binding) && binding.tmuxSession
      && await witnessedClaudeVersionLabel(paneCommand, { target: binding.tmuxSession, tmux: this.tmux, listProcesses: this.listProcesses }, witnessWait)) {
      return asClaude;
    }
    // Headerless managed launches (including bypass mode) use the same readiness
    // precedence as resume. This candidate result is returned only after the
    // exact launch identity below is proved; screen text alone is insufficient.
    const verifiedProbe = assessNativeResumeProbe({ ...input,
      claudeAutoIdentityVerified: true, claudeResumeIdentityVerified: true });
    if (probe.status === "resumed" || verifiedProbe.status !== "resumed") return probe;
    const launch = this.autoLaunches.get(binding.nodeId);
    // No launch record (this daemon did not launch the seat): the caller's real binding and the seat's recorded
    // conversation are the proof's inputs. A record for another launch keeps today's result below.
    if (!launch) return await this.proveWithoutLaunch(binding, options) ? { ...verifiedProbe, provedWithoutLaunch: true } : probe;
    if (!binding.tmuxPane || !binding.tmuxSession
      || launch.binding.id !== binding.id || launch.binding.tmuxPane !== binding.tmuxPane
      || launch.binding.tmuxSession !== binding.tmuxSession
      || launch.binding.launchGeneration !== binding.launchGeneration) return probe;
    try {
      const panes = await this.tmux.listPanes(binding.tmuxSession);
      if (panes.length !== 1 || panes[0]?.id !== binding.tmuxPane) return probe;
      const observation = { target: binding.tmuxPane, tmux: this.tmux,
        listProcesses: this.listProcesses, expectedToken: launch.token, selectedExecutable: launch.executable,
        scriptLaunch: launch.scriptLaunch };
      const first = await observeClaudePaneProcess(observation);
      if (!first) return probe;
      // Pin the first exact process for this launch; retries cannot adopt a replacement. It is also
      // the launch's record of the process it started (#1077). A process found through a script launch
      // is trusted on its first sight only once every other check has passed (below), so that an
      // unconfirmed sample is not what the launch is held to.
      const pin = () => {
        launch.fingerprint = first.fingerprint;
        if (first.process.startedAt) launch.process = { pid: first.process.pid, startedAt: first.process.startedAt };
      };
      if (!launch.fingerprint && !first.afterScript) pin();
      if (launch.fingerprint !== undefined && first.fingerprint !== launch.fingerprint) return probe;
      const native = await observeClaudePaneProcess(observation);
      if (native?.fingerprint !== first.fingerprint) return probe;
      const currentPanes = await this.tmux.listPanes(binding.tmuxSession);
      if (this.autoLaunches.get(binding.nodeId) !== launch || currentPanes.length !== 1
        || currentPanes[0]?.id !== binding.tmuxPane
        || await this.tmux.getPanePid(binding.tmuxSession) !== native.panePid) return probe;
      if (!launch.fingerprint) pin();
      // Another check of this launch can pin while this one awaits; only the pinned process is verified.
      if (launch.fingerprint !== first.fingerprint) return probe;
      return verifiedProbe;
    } catch { return probe; }
  }

  /** The observation `rig seat clear-attention` uses: the pane's one foreground Claude names exactly `resumeToken`, the
   *  same process in two samples, with no frozen executable, in the session's only pane with an unchanged PID. Reads
   *  only. Anything missing or inconclusive is not proof. */
  private async proveWithoutLaunch(binding: NodeBinding, options: ReadinessOptions | undefined): Promise<boolean> {
    const token = options?.resumeToken?.trim();
    if (!token || !binding.tmuxPane || !binding.tmuxSession) return false;
    try {
      const panes = await this.tmux.listPanes(binding.tmuxSession);
      if (panes.length !== 1 || panes[0]?.id !== binding.tmuxPane) return false;
      const native = await verifyClaudePaneProcess({ target: binding.tmuxPane, tmux: this.tmux,
        listProcesses: this.listProcesses, expectedToken: token, rotation: options?.resumeRotation ?? null });
      if (!native) return false;
      const currentPanes = await this.tmux.listPanes(binding.tmuxSession);
      return currentPanes.length === 1 && currentPanes[0]?.id === binding.tmuxPane
        && await this.tmux.getPanePid(binding.tmuxSession) === native.panePid;
    } catch { return false; }
  }

  /** tmux names a shell for every OpenRig launch (the launch script is `sh`), so its word alone can't say
   *  Claude is gone. With a bound pane, the process tree must show the pane's shell holding the terminal with
   *  nothing under it; Claude, or a launch script about to start it, is a slow resume. */
  private async paneReturnedToShell(binding: NodeBinding, paneCommand: string | null): Promise<boolean> {
    if (!paneCommand || !SHELL_COMMANDS.has(paneCommand)) return false;
    if (!binding.tmuxPane) return true;
    const observed = await observeClaudeDelivery({ target: binding.tmuxPane, tmux: this.tmux, listProcesses: this.listProcesses },
      { unknownKeepsIdle: false });
    return observed.state === "idle_shell";
  }

  /** Who holds the pane, by the observations already there. "another": positively something other than this launch's own
   *  start: a ready screen whose lineage failed the check (with a process list that could be read), a Claude naming
   *  another conversation, or a stable Codex. Waiting won't make any of them this launch's, and its token is not recorded
   *  as an attempt. "own": this launch's Claude. "unknown": nothing seen yet (the launch script is starting it) or a
   *  process list that can't be read, whatever the screen shows. One process listing serves the Claude observations. */
  private async paneOccupant(binding: NodeBinding, looksReady: boolean,
    options: { positiveConflictOnly?: boolean } = {}): Promise<"own" | "another" | "unknown" | "absent"> {
    const launch = this.autoLaunches.get(binding.nodeId);
    if (!binding.tmuxPane || !launch) return looksReady ? "another" : "unknown";
    let rows: Awaited<ReturnType<NativeProcessLister>>;
    try { rows = await (this.listProcesses ?? (() => listNativeProcesses({ claudeLaunchPaths: launch.scriptLaunch === true })))(); } catch { return "unknown"; }
    if (looksReady) return "another";
    const observation = { target: binding.tmuxPane, tmux: this.tmux, listProcesses: () => rows, selectedExecutable: launch.executable,
      scriptLaunch: launch.scriptLaunch };
    if (await observeClaudePaneProcess({ ...observation, expectedToken: launch.token })) return "own";
    const native = await observeClaudePaneRuntime(observation);
    if (native) {
      if (!options.positiveConflictOnly) return "another";
      // Fresh readiness keeps unidentified Claude processes unknown; strict resume callers above
      // retain their existing rule. Reuse the exact argv parser, not a best-effort token search.
      const named = claudeCommandSessionToken(native.process.command);
      return named !== null && named !== launch.token ? "another" : "unknown";
    }
    if (await observeCodexPaneProcess(observation)) {
      return await verifyCodexPaneProcess({ ...observation, listProcesses: this.listProcesses }) ? "another" : "unknown";
    }
    if (!options.positiveConflictOnly) return "unknown";
    const panePid = await this.tmux.getPanePid(binding.tmuxPane);
    // Missing pane identity is unavailable evidence. A Claude elsewhere in this pane's subtree
    // remains unproven, rather than absent, even if it is not a foreground candidate yet.
    return panePid && rows.some(row => row.pid === panePid) && !subtreeNamesClaudeExecutable(rows, panePid)
      ? "absent" : "unknown";
  }

  private async verifyResumeLaunch(binding: NodeBinding): Promise<HarnessLaunchResult> {
    const tmuxSession = binding.tmuxSession!;
    // A quick window, then a longer one only while the boot is still in progress, as the Codex adapter does it.
    // The longer one is the readiness setting less the quick window, as a number of polls counted from here; it is per
    // seat, nothing is shared across the seats of a restore. A setting no longer than the quick window adds no polls, but
    // an unresolved boot is still kept (attention_required) rather than failed.
    const pollMs = 200;
    const windowAttempts = 16;
    const checkEvery = 5;
    let attempts = windowAttempts;
    let slowStart = false;
    // #86: one record per wait; after an actual path-read timeout the rest of this wait skips the witness.
    const witnessWait: VersionLabelWitnessWait = { pathReadTimedOut: false };

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
      const probe = await this.assessManagedProbe(binding, paneCommand, paneContent, undefined, witnessWait);

      if (probe.code === "no_conversation_found") {
        return {
          ok: false,
          probe: await resumeProbeEvidence(probe, paneContent, this.tmux, tmuxSession),
          error: "Claude resume failed: no conversation found for the requested session",
          recovery: "retry_fresh",
          missingConversation: true,
        };
      }

      if (probe.status === "resumed") {
        return { ok: true };
      }

      // OPR.0.3.4.5: Claude resume-selection prompt -> attention_required,
      // never timed-out. The menu is alive and recoverable; auto-selecting
      // is governance BLOCKING. Surface evidence and exit immediately.
      if (probe.status === "attention_required") {
        return {
          ok: false,
          probe: await resumeProbeEvidence(probe, paneContent, this.tmux, tmuxSession),
          error: probe.detail,
          recovery: "attention_required",
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }

      if (this.autoDriveProviderPrompts && probe.code === "trust_gate") {
        // In the longer wait the occupant has not been looked at since the window ended: press Enter only for this launch's
        // own Claude. Anything else keeps main's result, as if the loop had ended.
        if (slowStart && await this.paneOccupant(binding, false) !== "own") {
          slowStart = false;
          break;
        }
        const enterResult = await this.tmux.sendKeys(tmuxSession, ["Enter"]);
        if (!enterResult.ok) {
          return { ok: false, error: `Claude trust prompt auto-drive failed: ${enterResult.message}`,
            probe: await resumeProbeEvidence(probe, paneContent, this.tmux, tmuxSession) };
        }
        await this.sleep(200);
        continue;
      }

      // Only a boot in progress (no verdict, no gate, a label that proves nothing) is worth waiting for; a real
      // gate (login, trust or MCP approval, auto-mode identity) won't clear itself.
      const booting = probe.code === "awaiting_runtime" || probe.code === "returned_to_shell";
      if (slowStart && !booting) {
        slowStart = false;
        break;
      }
      // A start in progress can't have drawn Claude's ready screen. One that has, with its lineage unproven, keeps
      // main's result whenever it draws: at the window's end, or at any poll of the longer wait.
      const looksReady = (attempt === windowAttempts - 1 || slowStart) && booting
        && assessNativeResumeProbe({ runtime: "claude-code", paneCommand, paneContent,
          claudeAutoIdentityVerified: true, claudeResumeIdentityVerified: true }).status === "resumed";
      if (slowStart && looksReady && await this.paneOccupant(binding, true) === "another") {
        slowStart = false;
        break;
      }
      // Checked where the window ends and then about once a second of the longer wait (two listings for the shell, one for
      // the occupant), not on every poll. A shell label can't tell Claude having exited from the launch script not having
      // started it yet, and the occupant can change while we wait, so the process tree decides.
      const windowEnd = attempt === windowAttempts - 1;
      if (booting && (windowEnd || (slowStart && (attempt - windowAttempts + 1) % checkEvery === 0))) {
        if (await this.paneReturnedToShell(binding, await this.tmux.getPaneCommand(tmuxSession))) {
          // Provably back at its shell: the final check reports it. If it isn't by then, the seat is kept.
          if (slowStart) { attempts = attempt + 1; break; }
        } else if (await this.paneOccupant(binding, looksReady) === "another") {
          // Not this launch's start: keep main's result.
          slowStart = false;
          break;
        } else if (windowEnd) {
          // A boot in progress, or one we can't see: keep the launch past the window even when the readiness setting
          // leaves no room for more polls (1 to 3 s), so it ends as attention_required, not as the failure that loses the token.
          attempts = windowAttempts + Math.floor(Math.max(0, resolveReadinessTimeoutMs(this.readinessTimeoutMs) - windowAttempts * pollMs) / pollMs);
          slowStart = true;
        }
      }
      if (attempt < attempts - 1) {
        await this.sleep(pollMs);
      }
    }

    const finalCommand = await this.tmux.getPaneCommand(tmuxSession);
    const finalContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
    const finalProbe = await this.assessManagedProbe(binding, finalCommand, finalContent, undefined, witnessWait);

    if (finalProbe.status === "resumed") {
      return { ok: true };
    }
    const probeEvidence = await resumeProbeEvidence(finalProbe, finalContent, this.tmux, tmuxSession);

    if (finalProbe.status === "attention_required" || finalProbe.code === "claude_auto_identity_required") {
      return {
        ok: false,
        probe: probeEvidence,
        error: finalProbe.detail,
        recovery: "attention_required",
        evidence: finalContent.split("\n").slice(-12).join("\n"),
      };
    }

    // The wait can end on the read that first shows Claude's missing-conversation report.
    if (finalProbe.code === "no_conversation_found") {
      return {
        ok: false,
        probe: probeEvidence,
        error: "Claude resume failed: no conversation found for the requested session",
        recovery: "retry_fresh",
        missingConversation: true,
      };
    }

    if (await this.paneReturnedToShell(binding, finalCommand)) {
      return {
        ok: false,
        probe: probeEvidence,
        error: "Claude resume failed: pane returned to shell instead of entering Claude",
        recovery: "retry_fresh",
      };
    }

    // The occupant can change after the last check in the loop, so the end of the wait looks once more, with the screen
    // judged as in the loop: a different occupant (or a ready-looking screen on a readable list) keeps main's result.
    if (slowStart && (finalProbe.code === "awaiting_runtime" || finalProbe.code === "returned_to_shell")
      && await this.paneOccupant(binding, assessNativeResumeProbe({ runtime: "claude-code", paneCommand: finalCommand, paneContent: finalContent,
        claudeAutoIdentityVerified: true, claudeResumeIdentityVerified: true }).status === "resumed") !== "another") {
      // Claude, or the script about to start it, may still be coming up. Keep the launch and its resume token for
      // a person (or the reconciler) rather than failing a seat that may be running. Never `resumed` from this.
      return {
        ok: false,
        error: `Claude resume did not finish within ${Math.round(attempts * pollMs / 1000)}s; Claude may still be starting, so the launch was kept`,
        probe: probeEvidence,
        recovery: "attention_required",
        evidence: finalContent.split("\n").slice(-12).join("\n"),
      };
    }
    return { ok: false, error: "Claude resume failed: timed out waiting for Claude to become active", probe: probeEvidence };
  }

  private projectEntry(entry: ProjectionEntry, cwd: string, managedBlockFile: ClaudeManagedBlockFile, warnings: string[], seatSkillsRoot?: string, seatSkillsRefused?: string): boolean {
    // A skipped fragment is reported skipped; it never falls through to the generic extensions copy.
    const handled = entry.category === "runtime_resource" ? this.applyRuntimeResource(entry, cwd, warnings) : false;
    if (handled) return handled === true;

    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, managedBlockFile);
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content, warnings, entry.absolutePath);
    }

    // HG-1.3 plugin runtime applicability filter (per DESIGN.md §5.1):
    // explicit pluginType="codex" → skip Claude projection;
    // pluginType="auto" (or unset) + no .claude-plugin/ manifest dir → skip;
    // explicit pluginType="claude" → project regardless of manifest presence.
    if (entry.category === "plugin" && !this.pluginAppliesToClaude(entry)) {
      return false;
    }

    const targetDir = this.resolveTargetDir(entry, cwd, seatSkillsRoot);
    if (!targetDir) return true;
    // OPR.0.7.0.13: never write through a link out of the seat's storage.
    // A refused seat storage refuses every skill meant for it, named; otherwise each destination is checked.
    const refusal = seatSkillsRoot && entry.category === "skill"
      ? seatSkillsRefused ?? seatSkillWriteRefusal(seatSkillsRoot, nodePath.join(targetDir, "SKILL.md")) : undefined;
    if (refusal) { warnings.push(`${entry.effectiveId}: ${refusal}`); return false; }

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

    // OPR.0.7.0.13: destinations refused below (a link on the way); an entry with any is reported incomplete, not projected.
    const notProjected: string[] = [];
    // OPR.0.7.0.13: a skill written to the seat's own storage is recorded (hash and source), identical copies too,
    // so `rig down` removes only what OpenRig wrote and a restore can put it back.
    const record = seatSkillsRoot && entry.category === "skill"
      ? (dest: string, src: string, content: string) => recordSeatSkillWrite(seatSkillsRoot, dest, src, content)
      : () => {};
    if (isDir && this.fs.listFiles) {
      // Directory-shaped: recursive copy
      let skippedPluginSkills = 0;
      for (const file of this.fs.listFiles(entry.absolutePath)) {
        // OPR.0.7.0.13: a seat with its own storage gets a selected plugin's bundled skills there, through its loadout, so
        // the project's copy of the plugin leaves its skills out; its manifest, hooks and settings are copied as before.
        if (seatSkillsRoot && entry.category === "plugin" && file.split(/[\\/]/)[0] === "skills") { skippedPluginSkills++; continue; }
        const src = nodePath.join(entry.absolutePath, file);
        const dest = nodePath.join(targetDir, file);
        // OPR.0.7.0.13: each destination in a seat's storage is checked before it's recorded, written or re-moded, so a
        // helper folder or file found to be a link is not written through (the identical-content, mode-only branch included).
        const refusedDest = seatSkillsRoot && entry.category === "skill" ? seatSkillWriteRefusal(seatSkillsRoot, dest) : undefined;
        if (refusedDest) { warnings.push(`${entry.effectiveId}: ${refusedDest}`); notProjected.push(dest); continue; }
        const content = this.fs.readFile(src);
        record(dest, src, content);
        // Reconcile mode even when the content write is skipped: a byte-identical dest
        // projected earlier may still carry the wrong (default) mode.
        if (this.fs.exists(dest) && hashContent(content) === hashContent(this.fs.readFile(dest))) {
          this.preserveMode(src, dest);
          continue;
        }
        this.fs.mkdirp(nodePath.dirname(dest));
        this.fs.writeFile(dest, content);
        this.preserveMode(src, dest);
      }
      const pluginLoss = seatSkillsRefused ? seatPluginSkillsLossNote(entry.effectiveId, skippedPluginSkills, seatSkillsRefused) : undefined;
      if (pluginLoss) warnings.push(pluginLoss);
    } else {
      // File-shaped: single file copy (subagents, hooks as YAML files)
      const destFile = nodePath.join(targetDir, nodePath.basename(entry.absolutePath));
      const refusedFile = seatSkillsRoot && entry.category === "skill" ? seatSkillWriteRefusal(seatSkillsRoot, destFile) : undefined;
      if (refusedFile) { warnings.push(`${entry.effectiveId}: ${refusedFile}`); return false; }
      const content = this.fs.readFile(entry.absolutePath);
      record(destFile, entry.absolutePath, content);
      if (this.fs.exists(destFile) && hashContent(content) === hashContent(this.fs.readFile(destFile))) {
        this.preserveMode(entry.absolutePath, destFile);
        return true;
      }
      this.fs.writeFile(destFile, content);
      this.preserveMode(entry.absolutePath, destFile);
    }
    return seatProjectionComplete(entry.effectiveId, notProjected, warnings);
  }

  /**
   * Reapply the source file's permission bits to the projected dest. Plain
   * readFile+writeFile (writeFileSync) creates the dest with the process default
   * mode, dropping executable bits on nested plugin helpers (e.g. the
   * claude-compaction-restore/scripts/*.mjs 0755 hooks). No-op when the fs adapter
   * does not expose mode primitives (keeps existing mock-fs callers unaffected).
   */
  private preserveMode(src: string, dest: string): void {
    if (!this.fs.statMode || !this.fs.chmod) return;
    const srcMode = this.fs.statMode(src) & 0o777;
    if ((this.fs.statMode(dest) & 0o777) !== srcMode) this.fs.chmod(dest, srcMode);
  }

  private pluginAppliesToClaude(entry: ProjectionEntry): boolean {
    const explicit = entry.pluginType ?? "auto";
    if (explicit === "claude") return true;
    if (explicit === "codex") return false;
    // auto: detect via .claude-plugin/plugin.json presence in the source tree
    return this.fs.exists(nodePath.join(entry.absolutePath, ".claude-plugin", "plugin.json"));
  }

  private resolveTargetDir(entry: ProjectionEntry, cwd: string, seatSkillsRoot?: string): string | null {
    switch (entry.category) {
      case "skill": return nodePath.join(seatSkillsRoot ?? nodePath.join(cwd, ".claude", "skills"), entry.effectiveId);
      case "guidance": return null; // handled via merge
      case "subagent": return nodePath.join(cwd, ".claude", "agents");
      case "plugin": return nodePath.join(cwd, ".claude", "plugins", entry.effectiveId);
      case "runtime_resource": return nodePath.join(cwd, ".claude", "extensions", entry.effectiveId);
      default: return null;
    }
  }

  /** true when applied, "skipped" when handled but not applied, false when this isn't a resource it handles. */
  private applyRuntimeResource(entry: ProjectionEntry, cwd: string, warnings: string[]): boolean | "skipped" {
    switch (entry.resourceType) {
      case "claude_settings_fragment":
        return this.mergeJsonFragment(entry.absolutePath, nodePath.join(cwd, ".claude", "settings.local.json"), warnings) || "skipped";
      case "claude_mcp_fragment":
        return this.mergeJsonFragment(entry.absolutePath, nodePath.join(cwd, ".mcp.json"), warnings) || "skipped";
      case "claude_activity_hooks":
        // Handled (no generic .claude/extensions copy): the relay asset is
        // delivered + the settings hooks reconciled by reconcileClaudeActivityHooks
        // off the always-run project() seam, not by per-entry projection.
        return true;
      default:
        return false;
    }
  }

  /** Merge a JSON fragment into a project file. An existing target that can't be read, or isn't a JSON object (it
   *  doesn't parse, or it holds an array or a single value), belongs to its owner: it's left as it is, nothing is
   *  merged, and a warning says so. Returns whether the fragment was applied. */
  private mergeJsonFragment(sourcePath: string, targetPath: string, warnings: string[]): boolean {
    const fragment = this.readJsonObjectStrict(sourcePath);
    // The reasons are fixed text: a parser message can quote the file's content.
    const leave = (reason: string) => {
      warnings.push(`Left ${targetPath} as it is: ${reason}. The fragment ${sourcePath} wasn't applied; once the file is fixed, the next fresh launch applies it (resuming or restoring the session doesn't).`);
      return false;
    };
    let existing: Record<string, unknown> = {};
    if (this.fs.exists(targetPath)) {
      let text: string;
      try { text = this.fs.readFile(targetPath); } catch { return leave("it couldn't be read"); }
      if (text.trim() !== "") {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { return leave("it isn't valid JSON"); }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return leave(`it holds ${Array.isArray(parsed) ? "a JSON array" : parsed === null ? "JSON null" : `a JSON ${typeof parsed}`}, not an object`);
        }
        existing = parsed as Record<string, unknown>;
      }
    }
    const merged = mergeJsonObjects(existing, fragment);
    this.fs.mkdirp(nodePath.dirname(targetPath));
    this.fs.writeFile(targetPath, JSON.stringify(merged, null, 2));
    return true;
  }

  /**
   * Merge a managed block into the target guidance file. Returns `true` when
   * the merge happened, `false` when intentionally skipped (currently only the
   * `rig-role` case — see comment). Callers propagate the skip signal so
   * ProjectionResult and StartupDeliveryResult report honest counts instead
   * of claiming a merge that never landed.
   */
  private mergeGuidance(targetPath: string, blockId: string, content: string, warnings: string[], sourcePath?: string): boolean {
    // The `rig-role` managed block is authored per seat but delivered through a
    // projection path that pairs (target-file × spec) without seat correlation,
    // so multiple pod-mates' role bodies collide into one CLAUDE.md. The fix
    // is to route per-seat content through the `send_text` startup path
    // instead, which preserves seat identity. Here we refuse the merge loudly
    // so the collision can't land silently. See ADR-0006.
    if (isPerSeatRoleGuidance(blockId, sourcePath)) {
      console.log(
        `[openrig] skip: effectiveId is ${blockId}, a seat's own role; per-seat delivery via send_text path required (target=${targetPath})`
      );
      const warning = perSeatRoleSkipWarning(blockId, targetPath);
      if (warning) warnings.push(warning);
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      warnings,
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }

  private detectDeliveryHint(path: string, content: string, orientation?: string): "guidance_merge" | "skill_install" | "send_text" {
    return resolveConcreteHint(path, content, orientation);
  }

  private provisionManagedBootstrap(binding: { nodeId?: string; cwd?: string | null; tmuxSession?: string | null; permissionMode?: NodeBinding["permissionMode"] }): void {
    // OPR.0.4.8.2 agnostic rip-out: provisionRigPermissions (C2) removed — OpenRig no longer
    // authors any config-file permission policy. Trust/onboarding (C3/C4) are neutral plumbing, kept.
    const home = this.fs.homedir ?? (typeof process !== "undefined" ? process.env.HOME : undefined);
    // Match launchHarness: an explicit permission mode exports the selected home to the child, so
    // only that home is provisioned.
    const managed = binding.permissionMode !== undefined ? this.claudeManagedLaunch : undefined;
    const cwd = binding.cwd === undefined && managed && binding.nodeId
      ? managed.boundCwd(binding.nodeId) : binding.cwd;
    const statePaths: string[] = [];
    const failures: string[] = [];
    if (managed) {
      // The seat's own home when it declares one (member or rig `env:`), else the daemon's.
      if (cwd) statePaths.push(managed.configPaths(cwd, binding.nodeId).statePath);
    } else {
      if (home) statePaths.push(nodePath.join(home, ".claude.json"));
      // A classic seat types `claude` into its pane's shell, which inherits the tmux server's
      // environment, not the daemon's, so the bootstrap cannot see which home that child reads.
      // When the seat's own `env:` or the daemon selects CLAUDE_CONFIG_DIR, provision that home too. This deliberately
      // replaces #565's rule that classic bootstrap writes exactly one file and leaves the
      // selected home untouched: a child that inherits the daemon's selection read neither.
      try {
        const selectedCwd = cwd ?? (binding.nodeId ? this.claudeManagedLaunch?.boundCwd(binding.nodeId) : undefined);
        const selected = selectedCwd ? this.claudeManagedLaunch?.selectedStatePath(selectedCwd, binding.nodeId) : undefined;
        if (selected && !statePaths.includes(selected)) statePaths.push(selected);
      } catch (err) {
        failures.push((err as Error).message);
      }
    }
    // Each file is merged on its own: unmergeable state in one is preserved and reported,
    // and never stops the other from being provisioned.
    for (const statePath of statePaths) {
      try {
        this.provisionClaudeState(statePath, cwd);
      } catch (err) {
        failures.push(`${statePath}: ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
  }

  private provisionClaudeState(statePath: string, cwd: string | null | undefined): void {
    // Preserve every existing field. Unreadable/malformed/non-object state is
    // left untouched and reported through the caller's best-effort bootstrap boundary.
    const state = this.fs.exists(statePath) ? this.readJsonObjectStrict(statePath) : {};
    // Running Claude processes read and write this file, so it is rewritten only when a flag is
    // missing: an already-provisioned file (every relaunch, resume and post-launch delivery) is left alone.
    let changed = false;
    if (cwd) {
      const projects = this.readJsonObjectField(state, "projects");
      if (Object.hasOwn(state, "projects") && projects !== state["projects"]) throw new Error("Claude bootstrap projects must be a JSON object; existing state preserved.");
      for (const trustKey of this.workspaceTrustKeys(cwd)) {
        const projectState = this.readJsonObjectField(projects, trustKey);
        if (Object.hasOwn(projects, trustKey) && projectState !== projects[trustKey]) throw new Error("Claude bootstrap project state must be a JSON object; existing state preserved.");
        if (projectState["hasTrustDialogAccepted"] === true) continue;
        projectState["hasTrustDialogAccepted"] = true;
        projects[trustKey] = projectState;
        changed = true;
      }
      state["projects"] = projects;
    }
    if (state["hasCompletedOnboarding"] !== true) {
      state["hasCompletedOnboarding"] = true;
      changed = true;
    }
    if (!changed) return;
    this.fs.mkdirp(nodePath.dirname(statePath));
    this.fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  // OPR.0.4.8.2 agnostic rip-out: the CONVENIENCE_BASELINE (global `Bash(rig:*)` allow) and its
  // provisionRigPermissions writer (assessment row C2 — wrote into ~/.claude/settings.json with an
  // `_openrig_provenance` marker) are DELETED. OpenRig no longer authors any config-file permission
  // policy; the harness-native permission surface is the control surface. Existing provenance-marked
  // user files are NOT retro-scrubbed — the new code simply never touches settings.json.

  private workspaceTrustKeys(cwd: string): string[] {
    const keys = new Set<string>([nodePath.resolve(cwd)]);
    try {
      keys.add(fs.realpathSync.native(cwd));
    } catch {
      // Best-effort only — non-existent test paths can still use the resolved input.
    }
    return Array.from(keys);
  }

  private readJsonObjectStrict(path: string): Record<string, unknown> {
    const parsed = JSON.parse(this.fs.readFile(path));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error(`${path} must be a JSON object`);
  }

  private readJsonObjectField(source: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = source[key];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  // OPR.0.4.8.2 rip-out: readStringArray removed — its only caller was provisionRigPermissions (C2).

  /**
   * Best-effort: provision the OpenRig context collector for managed Claude sessions.
   * Writes a collector script and merges status line config into .claude/settings.local.json.
   * Idempotent: safe to call multiple times (merge preserves existing settings). A user's own
   * status line command (anything but the exact command written below), or a file that does not
   * parse, is left as it is. The collector then never runs for that seat. While a valid sidecar
   * from an earlier collector is retained, context usage (shown as stale once it ages) and Claude
   * resume-token capture keep using it. That sidecar's session id may belong to an earlier Claude
   * session, so capture can record an older session id for such a seat. Once none exists:
   * - context usage reads unknown (`missing_sidecar`);
   * - resume-token capture at adoption or handover is skipped (`missing_sidecar`);
   * - its provider-usage row is an explicit unknown (`no_statusline_cache_yet`) unless an earlier
   *   cache for that seat is retained.
   * The read-modify-write below is not safe against a concurrent writer of the same file.
   */
  private provisionContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void {
    if (!this.stateDir || !this.collectorAssetPath || !binding.cwd) return;
    const contextDir = contextUsageDirectory(this.stateDir);
    const providerUsageDir = providerUsageDirectory(this.stateDir);
    this.fs.mkdirp(contextDir);
    this.fs.mkdirp(providerUsageDir);

    // 1. Copy collector script to project
    const collectorDest = nodePath.join(binding.cwd, ".openrig", "context-collector.cjs");
    this.fs.mkdirp(nodePath.dirname(collectorDest));
    this.fs.copyFile(this.collectorAssetPath, collectorDest);

    // 2. Merge status line config into .claude/settings.local.json
    const settingsPath = nodePath.join(binding.cwd, ".claude", "settings.local.json");
    this.fs.mkdirp(nodePath.dirname(settingsPath));

    // The seat cwd can be a shared repo whose project-local settings other sessions read (#421).
    // Like the activity hooks, never clobber text we cannot parse, nor valid JSON that isn't an
    // object (for example `[]`): the status line isn't installed there. An empty file holds no
    // settings and is treated as `{}`.
    let existing: Record<string, unknown> = {};
    if (this.fs.exists(settingsPath)) {
      const text = this.fs.readFile(settingsPath);
      if (text.trim() !== "") {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { return; }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
        existing = parsed as Record<string, unknown>;
      }
    }
    const statusLine = typeof existing["statusLine"] === "object" && existing["statusLine"] !== null
      ? existing["statusLine"] as Record<string, unknown> : {};
    // A user's own status line command wins; only OpenRig's collector command is installed or refreshed.
    // If this command's shape changes, keep the old shape recognised in isOwnedCollectorCommand, or
    // seats holding it will never be refreshed.
    const collectorCmd = managedClaudeNodeCommand(this.nodeExecutable, collectorDest, contextDir, providerUsageDir);
    const current = statusLine["command"];
    if (typeof current === "string" && current.trim() !== "" && current !== collectorCmd && !isOwnedCollectorCommand(current)) return;
    // Already installed as wanted: no write. Compared by value, so another writer's key order or spacing isn't a
    // change. This avoids rewriting on every poll; it doesn't make a needed write safe against a concurrent writer.
    if (statusLine["type"] === "command" && current === collectorCmd) return;

    existing["statusLine"] = { ...statusLine, type: "command", command: collectorCmd };

    this.fs.writeFile(settingsPath, JSON.stringify(existing, null, 2));
  }

  /**
   * Reconcile the OpenRig-managed activity-relay hooks in `.claude/settings.local.json`
   * to the desired `enabled` state, driven ONCE from the always-run `project()` seam.
   *
   * ENABLE (only when the relay SOURCE is readable): deliver `activity-relay.cjs` →
   * the configured instance state directory (mode preserved, 0755 from the source asset) and upsert
   * the owned command for each relay event DERIVED from the canonical claude.json manifest
   * (compaction hooks excluded). If the source is missing, deliver NOTHING (no dangling
   * commands) and report `sourceMissing` so the caller can surface a warning + not claim
   * projection. DISABLE: strip owned entries and prune emptied containers.
   *
   * Ownership is the exact generated Node-command shape (legacy or pinned interpreter), so a stale/changed
   * absolute prefix is replaced (never duplicated) while a user command that merely CONTAINS
   * the path is preserved. Fail-closed: a settings file we cannot parse is left byte-for-byte
   * untouched. Not `mergeJsonFragment` (additive union-by-key can't strip on disable).
   */
  private reconcileClaudeActivityHooks(cwd: string, enabled: boolean): ActivityHookOutcome {
    const relayDest = claudeActivityRelayPath(this.stateDir ?? undefined);
    const ownedCmd = managedClaudeNodeCommand(this.nodeExecutable, relayDest);
    const settingsPath = nodePath.join(cwd, ".claude", "settings.local.json");

    // PREVALIDATE BEFORE ANY MUTATION using the SHARED delivery validation (same gate
    // preflight uses — one parser, no drift). Enable is deliverable ONLY when BOTH the relay
    // source AND a nonempty canonical event set resolve. If enable is requested but not
    // deliverable (missing relay, or a missing/malformed/zero-relay-event manifest), do
    // NOTHING — no strip, no copy, no write — so existing managed hooks + settings bytes
    // are preserved and the resource is NOT claimed delivered/projected (⇒ warn + skip).
    const delivery = validateClaudeActivityHookDelivery(this.fs, this.activityRelayPath, this.claudeHooksManifestPath);
    const derivedEvents = delivery.events;
    const deliverable = enabled && delivery.deliverable;
    if (enabled && !deliverable) {
      return {
        changed: false, delivered: false,
        sourceMissing: !delivery.relaySourceOk,
        manifestUnavailable: delivery.relaySourceOk && delivery.events.length === 0,
        settingsUnparseable: false,
      };
    }

    const settingsExisted = this.fs.exists(settingsPath);
    // Fail closed: never clobber a settings file we cannot parse — preserve its bytes.
    let settings: Record<string, unknown>;
    if (settingsExisted) {
      try { settings = this.readJsonObjectStrict(settingsPath); }
      catch { return { changed: false, delivered: false, sourceMissing: false, manifestUnavailable: false, settingsUnparseable: true }; }
    } else {
      settings = {};
    }

    const hooks = this.readJsonObjectField(settings, "hooks");

    // 1. Strip OpenRig-owned relay entries (EXACT node-command shape) from all events;
    //    prune emptied groups + events. User-authored hooks are untouched.
    let changed = false;
    for (const event of Object.keys(hooks)) {
      const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : null;
      if (!groups) continue;
      const keptGroups: unknown[] = [];
      for (const group of groups) {
        if (!isPlainObject(group) || !Array.isArray(group["hooks"])) { keptGroups.push(group); continue; }
        const groupHooks = group["hooks"] as unknown[];
        const keptHooks = groupHooks.filter((h) => !isOwnedRelayCommand(hookCommand(h)));
        if (keptHooks.length !== groupHooks.length) changed = true;
        if (keptHooks.length === 0) continue; // prune emptied group
        keptGroups.push({ ...group, hooks: keptHooks });
      }
      if (keptGroups.length === 0) delete hooks[event]; // prune emptied event
      else hooks[event] = keptGroups;
    }

    // 2. Deliverable enable: copy the relay asset + upsert the owned entry for each
    //    PREVALIDATED relay event (derived from the canonical manifest above).
    if (deliverable) {
      this.fs.mkdirp(nodePath.dirname(relayDest));
      // Sibling seats share this relay. Do not truncate identical bytes while a hook reads it.
      if (!this.fs.exists(relayDest) || this.fs.readFile(relayDest) !== this.fs.readFile(this.activityRelayPath!)) {
        this.fs.copyFile(this.activityRelayPath!, relayDest);
      }
      this.preserveMode(this.activityRelayPath!, relayDest);
      for (const { event, timeout } of derivedEvents) {
        const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
        const hook: Record<string, unknown> = { type: "command", command: ownedCmd };
        if (typeof timeout === "number") hook["timeout"] = timeout;
        groups.push({ hooks: [hook] });
        hooks[event] = groups;
        changed = true;
      }
    }

    // 3. Persist only when something changed (never touch an unchanged / never-managed file).
    if (!changed) return { changed: false, delivered: deliverable, sourceMissing: false, manifestUnavailable: false, settingsUnparseable: false };
    if (Object.keys(hooks).length > 0) settings["hooks"] = hooks;
    else delete settings["hooks"];
    this.fs.mkdirp(nodePath.dirname(settingsPath));
    this.fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    return { changed: true, delivered: deliverable, sourceMissing: false, manifestUnavailable: false, settingsUnparseable: false };
  }

}

interface ActivityHookOutcome {
  /** A write happened (owned entries added or stripped). */
  changed: boolean;
  /** Enable succeeded — relay + hooks were actually delivered (stays PROJECTED). */
  delivered: boolean;
  /** Enable requested but the relay source was absent — nothing delivered (⇒ warn + skip). */
  sourceMissing: boolean;
  /** Enable requested, relay present, but the canonical manifest was missing/malformed/
   *  yielded zero relay events — nothing delivered, existing managed hooks preserved (⇒ warn + skip). */
  manifestUnavailable: boolean;
  /** Fail-closed: an unparseable settings file was preserved untouched. */
  settingsUnparseable: boolean;
}

// OpenRig-owned relay path suffix. Ownership is the generated Node command whose single
// argument ends with this path — a changed prefix still matches (replace, not duplicate); a
// user command that merely contains the path (echo, or node with extra args) does NOT.
const LEGACY_OWNED_RELAY_SUFFIX = "/.openrig/hooks/scripts/activity-relay.cjs";

function managedClaudeNodeCommand(executable: string, ...args: string[]): string {
  const quotedArgs = args.map(shellQuote).join(" ");
  const pinned = `${shellQuote(executable)} ${quotedArgs}`;
  // Keep legacy PATH resolution if this runtime's name is outside our ownership grammar.
  return parseManagedClaudeNodeCommand(pinned) ? pinned : `node ${quotedArgs}`;
}

function hookCommand(hook: unknown): string | undefined {
  return isPlainObject(hook) && typeof hook["command"] === "string" ? (hook["command"] as string) : undefined;
}

// OpenRig-owned collectors use canonical POSIX-quoted paths. Recognise older unquoted
// three/four-token commands too, but preserve commands composed with shell operators or
// extra arguments. Old unquoted paths containing spaces cannot be identified unambiguously.
const OWNED_COLLECTOR_SUFFIX = nodePath.sep + nodePath.join(".openrig", "context-collector.cjs");

function isOwnedCollectorCommand(cmd: string): boolean {
  if (/[\r\n]/.test(cmd)) return false;
  const parsed = parseManagedClaudeNodeCommand(cmd);
  if (parsed && (parsed.args.length === 2 || parsed.args.length === 3)) {
    return parsed.args[0]!.endsWith(OWNED_COLLECTOR_SUFFIX);
  }
  const tokens = cmd.trim().split(/\s+/);
  if ((tokens.length !== 3 && tokens.length !== 4) || tokens[0] !== "node") return false;
  if (tokens.some((token) => /[;&|<>`$()'"\\]/.test(token))) return false;
  return tokens[1]!.endsWith(OWNED_COLLECTOR_SUFFIX);
}

function isOwnedRelayCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  const parsed = parseManagedClaudeNodeCommand(cmd);
  if (!parsed || parsed.args.length !== 1) return false;
  const relay = parsed.args[0]!;
  return relay.endsWith("/plugins/openrig-core/hooks/scripts/activity-relay.cjs")
    || relay.endsWith(LEGACY_OWNED_RELAY_SUFFIX)
    || relay.endsWith(`/${CLAUDE_ACTIVITY_RELAY_RELATIVE_PATH}`);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function mergeJsonObjects(base: Record<string, unknown>, fragment: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(fragment)) {
    merged[key] = mergeJsonValue(merged[key], value);
  }
  return merged;
}

function mergeJsonValue(base: unknown, fragment: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(fragment)) {
    return mergeJsonObjects(base, fragment);
  }
  if (Array.isArray(base) && Array.isArray(fragment)) {
    return mergeJsonArrays(base, fragment);
  }
  return fragment;
}

function mergeJsonArrays(base: unknown[], fragment: unknown[]): unknown[] {
  const result = [...base];
  const seen = new Set(base.map(stableJsonKey));
  for (const item of fragment) {
    const key = stableJsonKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJsonKey(value: unknown): string {
  if (!isPlainObject(value)) return JSON.stringify(value);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return JSON.stringify(sorted);
}

// ── OPR.0.5.5.19 A5 — the Claude self-report rung (r3): sessions/<pid>.json ──
// Claude Code's OWN status registry (since v2.1.139): one JSON file per live process
// under <configDir>/sessions/, carrying {name: <canonical tmux session name>, status:
// busy|idle|shell|waiting, statusUpdatedAt, ...}. Self-reported truth, SELF-DATED
// (statusUpdatedAt) — the research doc's top rung, resolved here by the `name` field
// (OpenRig's canonical session name; no pane-pid plumbing needed on this path).
// UNDOCUMENTED INTERNAL: any read/parse/shape failure returns null — the ladder falls
// to the next rung, NEVER errors (SPEC mini-req 2a).

export interface ClaudeSelfReportRead {
  listFiles(dir: string): string[];
  readFile(path: string): string;
}

const defaultSelfReportRead: ClaudeSelfReportRead = {
  listFiles: (dir) => fs.readdirSync(dir),
  readFile: (p) => fs.readFileSync(p, "utf8"),
};

/** Read the freshest self-report for `sessionName` as ladder evidence, or null.
 *  Mapping: busy→working; idle→idle-at-prompt; shell→idle-at-prompt (turn over, a
 *  background shell lives — the omnigent-proven mapping); waiting→needs-input (a dialog
 *  owns input; Claude's internal `waiting` ≠ omnigent's — the collision both codebases
 *  warn about, kept OUT of the activity enum). */
export function readClaudeSelfReportEvidence(input: {
  sessionsDir: string;
  sessionName: string;
  seatNodeId: string;
  read?: ClaudeSelfReportRead;
}): import("../domain/activity-taxonomy.js").ActivityEvidence | null {
  const read = input.read ?? defaultSelfReportRead;
  try {
    let best: { status: string; statusUpdatedAt: number } | null = null;
    for (const file of read.listFiles(input.sessionsDir)) {
      if (!file.endsWith(".json")) continue;
      let record: { name?: unknown; status?: unknown; statusUpdatedAt?: unknown };
      try {
        record = JSON.parse(read.readFile(nodePath.join(input.sessionsDir, file))) as typeof record;
      } catch {
        continue; // one malformed file never breaks the rung
      }
      if (record.name !== input.sessionName) continue;
      if (typeof record.status !== "string" || typeof record.statusUpdatedAt !== "number") continue;
      if (!best || record.statusUpdatedAt > best.statusUpdatedAt) {
        best = { status: record.status, statusUpdatedAt: record.statusUpdatedAt };
      }
    }
    if (!best) return null;
    const base = {
      seatNodeId: input.seatNodeId,
      sessionName: input.sessionName,
      rung: "self-report" as const,
      sourceId: "claude:pid-json",
      seq: best.statusUpdatedAt, // self-dated monotonic
      observedAt: new Date(best.statusUpdatedAt).toISOString(),
    };
    switch (best.status) {
      case "busy":
        return { ...base, activity: "working" };
      case "idle":
      case "shell":
        return { ...base, activity: "idle-at-prompt" };
      case "waiting":
        return { ...base, needsInput: { count: 1, reason: "dialog owns input" } };
      default:
        return null; // unknown vocabulary — undocumented internal, never guess
    }
  } catch {
    return null; // unreadable dir ⇒ fall down the ladder
  }
}
