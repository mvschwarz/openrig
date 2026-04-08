import nodePath from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";

export interface ClaudeAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  copyFile(src: string, dest: string): void;
  listFiles?(dirPath: string): string[];
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
  private fs: ClaudeAdapterFsOps;
  private sessionIdFactory: () => string;
  private sleep: (ms: number) => Promise<void>;
  private stateDir: string | null;
  private collectorAssetPath: string | null;

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: ClaudeAdapterFsOps;
    sessionIdFactory?: () => string;
    sleep?: (ms: number) => Promise<void>;
    stateDir?: string;
    collectorAssetPath?: string;
  }) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.sessionIdFactory = deps.sessionIdFactory ?? randomUUID;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.stateDir = deps.stateDir ?? null;
    this.collectorAssetPath = deps.collectorAssetPath ?? null;
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
        this.projectEntry(entry, binding.cwd);
        projected.push(entry.effectiveId);
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
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
            this.mergeGuidance(targetPath, file.path, content);
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".claude", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
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

  async launchHarness(binding: NodeBinding, opts: { name: string; resumeToken?: string }): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch Claude Code harness" };
    }

    const generatedSessionId = opts.resumeToken ? null : this.sessionIdFactory();
    const cmd = opts.resumeToken
      ? `claude --resume ${opts.resumeToken} --name ${opts.name}`
      : `claude --session-id ${generatedSessionId} --name ${opts.name}`;

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
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "claude_id" };
    }

    // Belt-and-suspenders: prefer an immediately discoverable persisted session,
    // but fall back to the UUID we assigned explicitly at launch time.
    const token = this.captureResumeToken(opts.name);
    return { ok: true, resumeToken: token ?? generatedSessionId ?? undefined, resumeType: "claude_id" };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    return alive ? { ready: true } : { ready: false, reason: "tmux session not responsive" };
  }

  /** Best-effort public seam for tmux-bound Claude sessions adopted outside the launch path. */
  ensureContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void {
    this.provisionContextCollector(binding);
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
        return { ok: false, error: "Claude resume failed: no conversation found for the requested session" };
      }

      if (probe.status === "resumed") {
        return { ok: true };
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

    if (finalCommand && SHELL_COMMANDS.has(finalCommand)) {
      return { ok: false, error: "Claude resume failed: pane returned to shell instead of entering Claude" };
    }

    return { ok: false, error: "Claude resume failed: timed out waiting for Claude to become active" };
  }

  private projectEntry(entry: ProjectionEntry, cwd: string): void {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, "CLAUDE.md");
      const content = this.fs.readFile(entry.absolutePath);
      this.mergeGuidance(targetPath, entry.effectiveId, content);
      return;
    }

    const targetDir = this.resolveTargetDir(entry, cwd);
    if (!targetDir) return;

    this.fs.mkdirp(targetDir);
    const isDir = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath).length > 0 : false;

    if (isDir && this.fs.listFiles) {
      // Directory-shaped: recursive copy
      for (const file of this.fs.listFiles(entry.absolutePath)) {
        const src = nodePath.join(entry.absolutePath, file);
        const dest = nodePath.join(targetDir, file);
        const content = this.fs.readFile(src);
        if (this.fs.exists(dest) && hashContent(content) === hashContent(this.fs.readFile(dest))) continue;
        this.fs.mkdirp(nodePath.dirname(dest));
        this.fs.writeFile(dest, content);
      }
    } else {
      // File-shaped: single file copy (subagents, hooks as YAML files)
      const content = this.fs.readFile(entry.absolutePath);
      const destFile = nodePath.join(targetDir, nodePath.basename(entry.absolutePath));
      if (this.fs.exists(destFile) && hashContent(content) === hashContent(this.fs.readFile(destFile))) return;
      this.fs.writeFile(destFile, content);
    }
  }

  private resolveTargetDir(entry: ProjectionEntry, cwd: string): string | null {
    switch (entry.category) {
      case "skill": return nodePath.join(cwd, ".claude", "skills", entry.effectiveId);
      case "guidance": return null; // handled via merge
      case "subagent": return nodePath.join(cwd, ".claude", "agents");
      case "hook": return nodePath.join(cwd, ".claude", "hooks");
      case "runtime_resource": return nodePath.join(cwd, ".claude", "extensions", entry.effectiveId);
      default: return null;
    }
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): void {
    mergeManagedBlock(this.fs, targetPath, blockId, content);
  }

  /**
   * Best-effort token capture from ~/.claude/sessions/*.json.
   * Finds the session file whose name matches the expected session name.
   * Returns the sessionId if found, undefined otherwise.
   */
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

  /**
   * Best-effort: provision the OpenRig context collector for managed Claude sessions.
   * Writes a collector script and merges status line config into .claude/settings.local.json.
   * Idempotent: safe to call multiple times (merge preserves existing settings).
   */
  private provisionContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void {
    if (!this.stateDir || !this.collectorAssetPath || !binding.cwd) return;
    const contextDir = nodePath.join(this.stateDir, "context");

    // 1. Copy collector script to project
    const collectorDest = nodePath.join(binding.cwd, ".openrig", "context-collector.cjs");
    this.fs.mkdirp(nodePath.dirname(collectorDest));
    this.fs.copyFile(this.collectorAssetPath, collectorDest);

    // 2. Merge status line config into .claude/settings.local.json
    const settingsPath = nodePath.join(binding.cwd, ".claude", "settings.local.json");
    this.fs.mkdirp(nodePath.dirname(settingsPath));

    let existing: Record<string, unknown> = {};
    try {
      if (this.fs.exists(settingsPath)) {
        existing = JSON.parse(this.fs.readFile(settingsPath));
      }
    } catch { /* corrupt file — overwrite */ }

    const collectorCmd = `node ${collectorDest} ${contextDir}`;
    existing["statusLine"] = {
      ...(typeof existing["statusLine"] === "object" && existing["statusLine"] !== null ? existing["statusLine"] as Record<string, unknown> : {}),
      type: "command",
      command: collectorCmd,
    };

    this.fs.writeFile(settingsPath, JSON.stringify(existing, null, 2));
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
