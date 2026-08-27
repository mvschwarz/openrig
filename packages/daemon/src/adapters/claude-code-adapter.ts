import nodePath from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import { claudePostureFlag, claudeClassicRendererEnvPrefix } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { shellQuote } from "./shell-quote.js";
import { validateClaudeActivityHookDelivery } from "../domain/claude-activity-hooks.js";
import { observeClaudePermission } from "../domain/permission-drift.js";

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

// Real Claude Code binary needs 1-3s to write the new fork session-name
// file under ~/.claude/sessions/. Poll instead of single-shot lookup.
// 12 × 500ms = 6s ceiling — comfortably above the observed cold-start
// fork-file write window without making a bad-token error feel slow.
const FORK_POLL_ATTEMPTS = 12;
const FORK_POLL_DELAY_MS = 500;

/**
 * Claude Code runtime adapter. Projects resources to .claude/ targets
 * and delivers startup files via guidance merge, skill install, or tmux send-text.
 */
export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly runtime = "claude-code";
  private tmux: TmuxAdapter;
  private fs: ClaudeAdapterFsOps;
  private sessionIdFactory: () => string;
  private sleep: (ms: number) => Promise<void>;
  private stateDir: string | null;
  private collectorAssetPath: string | null;
  private autoDriveProviderPrompts: boolean;
  private activityRelayPath: string | null;
  private claudeHooksManifestPath: string | null;
  /** P20 — called after a projected file is written to a target, so the manifest
   *  records what we last wrote (→ operator-vs-stale discrimination). No-op by default. */
  private recordProjection: (targetPath: string, content: string) => void;

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: ClaudeAdapterFsOps;
    sessionIdFactory?: () => string;
    sleep?: (ms: number) => Promise<void>;
    stateDir?: string;
    collectorAssetPath?: string;
    autoDriveProviderPrompts?: boolean;
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
    this.fs = deps.fsOps;
    this.sessionIdFactory = deps.sessionIdFactory ?? randomUUID;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.stateDir = deps.stateDir ?? null;
    this.collectorAssetPath = deps.collectorAssetPath ?? null;
    this.autoDriveProviderPrompts = deps.autoDriveProviderPrompts ?? false;
    this.activityRelayPath = deps.activityRelayPath ?? null;
    this.claudeHooksManifestPath = deps.claudeHooksManifestPath ?? null;
    this.recordProjection = deps.recordProjection ?? (() => {});
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = nodePath.join(binding.cwd, ".claude", "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }

      try {
        const didProject = this.projectEntry(entry, binding.cwd);
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
      console.error(`[openrig] claude activity-hook reconcile warning: ${(err as Error).message}`);
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

    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    try { this.ensureManagedBootstrap(binding); } catch (err) {
      console.error(`[openrig] claude bootstrap warning: ${(err as Error).message}`);
    }

    // Best-effort: provision context collector for managed Claude sessions
    try { this.ensureContextCollector(binding); } catch (err) {
      // Log but don't fail — collector provisioning is best-effort
      console.error(`[openrig] context collector provisioning warning: ${(err as Error).message}`);
    }

    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? this.detectDeliveryHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "CLAUDE.md");
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".claude", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            const skillTarget = nodePath.join(targetDir, nodePath.basename(file.path));
            this.fs.writeFile(skillTarget, content);
            // P20 — record what we just wrote so the next projection can tell a
            // stale re-projection (safe overwrite) from an operator edit (protect).
            this.recordProjection(skillTarget, content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
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

    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: import("../domain/runtime-adapter.js").ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch Claude Code harness" };
    }

    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }

    // OPR.0.4.8.2: the acceptEdits floor by default; YOLO (opt-in) swaps in the full-bypass flag.
    // The SAME decision (claudePostureFlag) is used on the restore path (claude-resume.ts).
    // OPR.0.4.8.3 Seam B: a per-seat resolved policy posture (binding.launchPosture) overrides env.
    const permissionMode = claudePostureFlag(process.env, binding.launchPosture);
    const appliedLaunch = observeClaudePermission(permissionMode);
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

    // Fork branch: build `claude --resume <parent> --fork-session --name <seat>`
    // and capture the NEW post-fork session id. The parent token is NEVER
    // persisted onto the new seat record (identity-honesty bedrock).
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
      const cmd = `${rendererPrefix}claude ${permissionMode}${modelArg} --resume ${parentId} --fork-session --name ${opts.name}`;
      const textResult = await this.tmux.sendText(binding.tmuxSession, cmd);
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
      }
      const enterResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
      if (!enterResult.ok) {
        return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
      }
      // claude needs 1-3s to write the new fork session-name file under
      // ~/.claude/sessions/. The original implementation captured the
      // token IMMEDIATELY after Enter, which always returned undefined
      // against a real binary. Poll on the
      // verifyResumeLaunch cadence (12 × 500ms = 6s ceiling).
      const newToken = await this.pollForResumeToken(opts.name, FORK_POLL_ATTEMPTS, FORK_POLL_DELAY_MS);
      if (!newToken) {
        return {
          ok: false,
          error: `claude-code fork: could not capture new post-fork session id from claude session storage after ${FORK_POLL_ATTEMPTS} polls (${(FORK_POLL_ATTEMPTS * FORK_POLL_DELAY_MS) / 1000}s ceiling)`,
        };
      }
      return { ok: true, resumeToken: newToken, resumeType: "claude_id", appliedLaunch };
    }

    const generatedSessionId = opts.resumeToken ? null : this.sessionIdFactory();
    const cmd = opts.resumeToken
      ? `${rendererPrefix}claude ${permissionMode}${modelArg} --resume ${opts.resumeToken} --name ${opts.name}`
      : `${rendererPrefix}claude ${permissionMode}${modelArg} --session-id ${generatedSessionId} --name ${opts.name}`;

    const textResult = await this.tmux.sendText(binding.tmuxSession, cmd);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }
    // Send Enter to execute
    const enterResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
    if (!enterResult.ok) {
      return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
    }

    if (opts.resumeToken) {
      const verification = await this.verifyResumeLaunch(binding.tmuxSession);
      if (!verification.ok) return verification;
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "claude_id", appliedLaunch };
    }

    // Belt-and-suspenders: prefer an immediately discoverable persisted session,
    // but fall back to the UUID we assigned explicitly at launch time.
    const token = this.captureResumeToken(opts.name);
    return { ok: true, resumeToken: token ?? generatedSessionId ?? undefined, resumeType: "claude_id", appliedLaunch };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session not responsive" };
    }

    const paneCommand = await this.tmux.getPaneCommand(binding.tmuxSession);
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    const probe = assessNativeResumeProbe({
      runtime: "claude-code",
      paneCommand,
      paneContent,
    });

    if (probe.status === "resumed") return { ready: true };
    return { ready: false, reason: probe.detail, code: probe.code };
  }

  /** Best-effort public seam for tmux-bound Claude sessions adopted outside the launch path. */
  ensureContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void {
    this.provisionContextCollector(binding);
  }

  /** Best-effort public seam for user-scope Claude bootstrap used by managed sessions. */
  ensureManagedBootstrap(binding: { cwd?: string | null; tmuxSession?: string | null }): void {
    this.provisionManagedBootstrap(binding);
  }

  // -- Private helpers --

  private async verifyResumeLaunch(tmuxSession: string): Promise<HarnessLaunchResult> {
    const attempts = 16;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
      const probe = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand,
        paneContent,
      });

      if (probe.code === "no_conversation_found") {
        return {
          ok: false,
          error: "Claude resume failed: no conversation found for the requested session",
          recovery: "retry_fresh",
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
          error: probe.detail,
          recovery: "attention_required",
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }

      if (this.autoDriveProviderPrompts && probe.code === "trust_gate") {
        const enterResult = await this.tmux.sendKeys(tmuxSession, ["Enter"]);
        if (!enterResult.ok) {
          return { ok: false, error: `Claude trust prompt auto-drive failed: ${enterResult.message}` };
        }
        await this.sleep(200);
        continue;
      }

      if (attempt < attempts - 1) {
        await this.sleep(200);
      }
    }

    const finalCommand = await this.tmux.getPaneCommand(tmuxSession);
    const finalContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
    const finalProbe = assessNativeResumeProbe({
      runtime: "claude-code",
      paneCommand: finalCommand,
      paneContent: finalContent,
    });

    if (finalProbe.status === "resumed") {
      return { ok: true };
    }

    if (finalProbe.status === "attention_required") {
      return {
        ok: false,
        error: finalProbe.detail,
        recovery: "attention_required",
        evidence: finalContent.split("\n").slice(-12).join("\n"),
      };
    }

    if (finalCommand && SHELL_COMMANDS.has(finalCommand)) {
      return {
        ok: false,
        error: "Claude resume failed: pane returned to shell instead of entering Claude",
        recovery: "retry_fresh",
      };
    }

    return { ok: false, error: "Claude resume failed: timed out waiting for Claude to become active" };
  }

  private projectEntry(entry: ProjectionEntry, cwd: string): boolean {
    if (entry.category === "runtime_resource" && this.applyRuntimeResource(entry, cwd)) {
      return true;
    }

    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, "CLAUDE.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    // HG-1.3 plugin runtime applicability filter (per DESIGN.md §5.1):
    // explicit pluginType="codex" → skip Claude projection;
    // pluginType="auto" (or unset) + no .claude-plugin/ manifest dir → skip;
    // explicit pluginType="claude" → project regardless of manifest presence.
    if (entry.category === "plugin" && !this.pluginAppliesToClaude(entry)) {
      return false;
    }

    const targetDir = this.resolveTargetDir(entry, cwd);
    if (!targetDir) return true;

    this.fs.mkdirp(targetDir);
    const isDir = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath).length > 0 : false;

    if (isDir && this.fs.listFiles) {
      // Directory-shaped: recursive copy
      for (const file of this.fs.listFiles(entry.absolutePath)) {
        const src = nodePath.join(entry.absolutePath, file);
        const dest = nodePath.join(targetDir, file);
        const content = this.fs.readFile(src);
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
    } else {
      // File-shaped: single file copy (subagents, hooks as YAML files)
      const content = this.fs.readFile(entry.absolutePath);
      const destFile = nodePath.join(targetDir, nodePath.basename(entry.absolutePath));
      if (this.fs.exists(destFile) && hashContent(content) === hashContent(this.fs.readFile(destFile))) {
        this.preserveMode(entry.absolutePath, destFile);
        return true;
      }
      this.fs.writeFile(destFile, content);
      this.preserveMode(entry.absolutePath, destFile);
    }
    return true;
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

  private resolveTargetDir(entry: ProjectionEntry, cwd: string): string | null {
    switch (entry.category) {
      case "skill": return nodePath.join(cwd, ".claude", "skills", entry.effectiveId);
      case "guidance": return null; // handled via merge
      case "subagent": return nodePath.join(cwd, ".claude", "agents");
      case "plugin": return nodePath.join(cwd, ".claude", "plugins", entry.effectiveId);
      case "runtime_resource": return nodePath.join(cwd, ".claude", "extensions", entry.effectiveId);
      default: return null;
    }
  }

  private applyRuntimeResource(entry: ProjectionEntry, cwd: string): boolean {
    switch (entry.resourceType) {
      case "claude_settings_fragment":
        this.mergeJsonFragment(entry.absolutePath, nodePath.join(cwd, ".claude", "settings.local.json"));
        return true;
      case "claude_mcp_fragment":
        this.mergeJsonFragment(entry.absolutePath, nodePath.join(cwd, ".mcp.json"));
        return true;
      case "claude_activity_hooks":
        // Handled (no generic .claude/extensions copy): the relay asset is
        // delivered + the settings hooks reconciled by reconcileClaudeActivityHooks
        // off the always-run project() seam, not by per-entry projection.
        return true;
      default:
        return false;
    }
  }

  private mergeJsonFragment(sourcePath: string, targetPath: string): void {
    const fragment = this.readJsonObjectStrict(sourcePath);
    const existing = this.readJsonObject(targetPath);
    const merged = mergeJsonObjects(existing, fragment);
    this.fs.mkdirp(nodePath.dirname(targetPath));
    this.fs.writeFile(targetPath, JSON.stringify(merged, null, 2));
  }

  /**
   * Merge a managed block into the target guidance file. Returns `true` when
   * the merge happened, `false` when intentionally skipped (currently only the
   * `rig-role` case — see comment). Callers propagate the skip signal so
   * ProjectionResult and StartupDeliveryResult report honest counts instead
   * of claiming a merge that never landed.
   */
  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // The `rig-role` managed block is authored per seat but delivered through a
    // projection path that pairs (target-file × spec) without seat correlation,
    // so multiple pod-mates' role bodies collide into one CLAUDE.md. The fix
    // is to route per-seat content through the `send_text` startup path
    // instead, which preserves seat identity. Here we refuse the merge loudly
    // so the collision can't land silently. See ADR-0006.
    if (blockId === "rig-role") {
      console.log(
        `[openrig] skip: effectiveId is rig-role, per-seat delivery via send_text path required (target=${targetPath})`
      );
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }

  /**
   * Best-effort token capture from ~/.claude/sessions/*.json.
   * Finds the session file whose name matches the expected session name.
   * Returns the sessionId if found, undefined otherwise.
   */
  /**
   * PL-016 hardening v0+1 — poll captureResumeToken on the
   * verifyResumeLaunch cadence. Returns the token as soon as the
   * session file appears, or undefined after attempts × delayMs ceiling.
   * Used by the fork branch where the new session-name file appears
   * 1-3s after the Enter key is sent (cold-start fork-file write).
   */
  private async pollForResumeToken(
    expectedName: string,
    attempts: number,
    delayMs: number,
  ): Promise<string | undefined> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const token = this.captureResumeToken(expectedName);
      if (token) return token;
      if (attempt < attempts - 1) {
        await this.sleep(delayMs);
      }
    }
    return undefined;
  }

  private captureResumeToken(expectedName: string): string | undefined {
    try {
      const home = this.fs.homedir ?? (typeof process !== "undefined" ? process.env.HOME : undefined);
      if (!home || !this.fs.readdir) return undefined;
      const sessDir = nodePath.join(home, ".claude", "sessions");
      if (!this.fs.exists(sessDir)) return undefined;
      const files = this.fs.readdir(sessDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const content = this.fs.readFile(nodePath.join(sessDir, file));
          const data = JSON.parse(content) as { sessionId?: string; name?: string };
          if (data.name === expectedName && data.sessionId) {
            return data.sessionId;
          }
        } catch { /* skip malformed files */ }
      }
    } catch { /* best-effort */ }
    return undefined;
  }

  private detectDeliveryHint(path: string, content: string): "guidance_merge" | "skill_install" | "send_text" {
    return resolveConcreteHint(path, content);
  }

  private provisionManagedBootstrap(binding: { cwd?: string | null; tmuxSession?: string | null }): void {
    // OPR.0.4.8.2 agnostic rip-out: provisionRigPermissions (C2) removed — OpenRig no longer
    // authors any config-file permission policy. Trust/onboarding (C3/C4) are neutral plumbing, kept.
    this.provisionWorkspaceTrust(binding.cwd ?? null);
    this.provisionOnboardingState();
  }

  // OPR.0.4.8.2 agnostic rip-out: the CONVENIENCE_BASELINE (global `Bash(rig:*)` allow) and its
  // provisionRigPermissions writer (assessment row C2 — wrote into ~/.claude/settings.json with an
  // `_openrig_provenance` marker) are DELETED. OpenRig no longer authors any config-file permission
  // policy; the harness-native permission surface is the control surface. Existing provenance-marked
  // user files are NOT retro-scrubbed — the new code simply never touches settings.json.

  private provisionWorkspaceTrust(cwd: string | null): void {
    if (!cwd) return;
    const home = this.fs.homedir ?? (typeof process !== "undefined" ? process.env.HOME : undefined);
    if (!home) return;

    const statePath = nodePath.join(home, ".claude.json");
    const state = this.readJsonObject(statePath);
    const projects = this.readJsonObjectField(state, "projects");

    for (const trustKey of this.workspaceTrustKeys(cwd)) {
      const projectState = this.readJsonObjectField(projects, trustKey);
      projectState["hasTrustDialogAccepted"] = true;
      projects[trustKey] = projectState;
    }

    state["projects"] = projects;
    this.fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  private provisionOnboardingState(): void {
    const home = this.fs.homedir ?? (typeof process !== "undefined" ? process.env.HOME : undefined);
    if (!home) return;

    const statePath = nodePath.join(home, ".claude.json");
    const state = this.readJsonObject(statePath);
    state["hasCompletedOnboarding"] = true;
    this.fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  private workspaceTrustKeys(cwd: string): string[] {
    const keys = new Set<string>([nodePath.resolve(cwd)]);
    try {
      keys.add(fs.realpathSync.native(cwd));
    } catch {
      // Best-effort only — non-existent test paths can still use the resolved input.
    }
    return Array.from(keys);
  }

  private readJsonObject(path: string): Record<string, unknown> {
    try {
      if (!this.fs.exists(path)) return {};
      const parsed = JSON.parse(this.fs.readFile(path));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
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
   * Idempotent: safe to call multiple times (merge preserves existing settings).
   */
  private provisionContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void {
    if (!this.stateDir || !this.collectorAssetPath || !binding.cwd) return;
    const contextDir = nodePath.join(this.stateDir, "context");
    const providerUsageDir = nodePath.join(this.stateDir, "provider-usage");
    this.fs.mkdirp(providerUsageDir);

    // 1. Copy collector script to project
    const collectorDest = nodePath.join(binding.cwd, ".openrig", "context-collector.cjs");
    this.fs.mkdirp(nodePath.dirname(collectorDest));
    this.fs.copyFile(this.collectorAssetPath, collectorDest);

    // 2. Merge status line config into .claude/settings.local.json
    const settingsPath = nodePath.join(binding.cwd, ".claude", "settings.local.json");
    this.fs.mkdirp(nodePath.dirname(settingsPath));

    const existing = this.readJsonObject(settingsPath);

    const collectorCmd = `node ${collectorDest} ${contextDir} ${providerUsageDir}`;
    existing["statusLine"] = {
      ...(typeof existing["statusLine"] === "object" && existing["statusLine"] !== null ? existing["statusLine"] as Record<string, unknown> : {}),
      type: "command",
      command: collectorCmd,
    };

    this.fs.writeFile(settingsPath, JSON.stringify(existing, null, 2));
  }

  /**
   * Reconcile the OpenRig-managed activity-relay hooks in `.claude/settings.local.json`
   * to the desired `enabled` state, driven ONCE from the always-run `project()` seam.
   *
   * ENABLE (only when the relay SOURCE is readable): deliver `activity-relay.cjs` →
   * `<cwd>/.openrig/hooks/scripts/` (mode preserved, 0755 from the source asset) and upsert
   * the owned command for each relay event DERIVED from the canonical claude.json manifest
   * (compaction hooks excluded). If the source is missing, deliver NOTHING (no dangling
   * commands) and report `sourceMissing` so the caller can surface a warning + not claim
   * projection. DISABLE: strip owned entries and prune emptied containers.
   *
   * Ownership is the EXACT `node <quoted relay path>` command shape, so a stale/changed
   * absolute prefix is replaced (never duplicated) while a user command that merely CONTAINS
   * the path is preserved. Fail-closed: a settings file we cannot parse is left byte-for-byte
   * untouched. Not `mergeJsonFragment` (additive union-by-key can't strip on disable).
   */
  private reconcileClaudeActivityHooks(cwd: string, enabled: boolean): ActivityHookOutcome {
    const relayDest = nodePath.join(cwd, ".openrig", "hooks", "scripts", "activity-relay.cjs");
    const ownedCmd = `node ${shellQuote(relayDest)}`;
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
      this.fs.copyFile(this.activityRelayPath!, relayDest);
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

// OpenRig-owned relay path suffix. Ownership is the EXACT `node <arg>` command whose single
// argument ends with this path — a changed prefix still matches (replace, not duplicate); a
// user command that merely contains the path (echo, or node with extra args) does NOT.
const OWNED_RELAY_SUFFIX = "/.openrig/hooks/scripts/activity-relay.cjs";

function hookCommand(hook: unknown): string | undefined {
  return isPlainObject(hook) && typeof hook["command"] === "string" ? (hook["command"] as string) : undefined;
}

function isOwnedRelayCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  const m = /^node\s+(.+)$/.exec(cmd.trim());
  if (!m) return false;
  const arg = m[1]!;
  const decoded = unquoteSingleShellToken(arg);
  if (decoded === null) return false;
  // Canonical ONE-TOKEN round-trip: the argument must be EXACTLY one shellQuote token — re-encoding
  // the decoded path must reproduce the argument VERBATIM. This is the ownership test's core: the
  // command is `node ${shellQuote(relayDest)}`, so any owned entry re-encodes to itself (including
  // an apostrophe cwd O'Brien via the '"'"' escape). It REJECTS a user command whose multiple quoted
  // args merely concatenate to text ending in the relay suffix (e.g. `node 'x' '<relay>'`), which
  // must never be recognised as owned and deleted.
  if (shellQuote(decoded) !== arg) return false;
  return decoded.endsWith(OWNED_RELAY_SUFFIX);
}

/** Decode ONE POSIX single-quoted shell token as produced by shellQuote (outer `'…'` with an
 *  embedded `'` escaped as `'"'"'`). Returns null when the token is not single-quote wrapped. The
 *  caller re-encodes to confirm the token is canonical/single — this decode alone does not. */
function unquoteSingleShellToken(token: string): string | null {
  if (token.length < 2 || !token.startsWith("'") || !token.endsWith("'")) return null;
  return token.slice(1, -1).split(`'"'"'`).join("'");
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
