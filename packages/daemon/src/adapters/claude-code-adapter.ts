import nodePath from "node:path";
import fs from "node:fs";
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
  private activityHookRelayAssetPath: string | null;

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: ClaudeAdapterFsOps;
    sessionIdFactory?: () => string;
    sleep?: (ms: number) => Promise<void>;
    stateDir?: string;
    collectorAssetPath?: string;
    activityHookRelayAssetPath?: string;
  }) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.sessionIdFactory = deps.sessionIdFactory ?? randomUUID;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.stateDir = deps.stateDir ?? null;
    this.collectorAssetPath = deps.collectorAssetPath ?? null;
    this.activityHookRelayAssetPath = deps.activityHookRelayAssetPath ?? null;
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

    // Best-effort: provision permissions and MCP config for managed Claude sessions
    try { this.provisionPermissionsAndMcps(binding); } catch (err) {
      console.error(`[openrig] permissions/MCP provisioning warning: ${(err as Error).message}`);
    }

    // Best-effort: provision project-local activity hooks. The hook token is
    // supplied through tmux session env, never written to provider settings.
    try { this.provisionActivityHooks(binding); } catch (err) {
      console.error(`[openrig] claude activity hook provisioning warning: ${(err as Error).message}`);
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
    const permissionMode = "--permission-mode acceptEdits";
    const cmd = opts.resumeToken
      ? `claude ${permissionMode} --resume ${opts.resumeToken} --name ${opts.name}`
      : `claude ${permissionMode} --session-id ${generatedSessionId} --name ${opts.name}`;

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
      return {
        ok: false,
        error: "Claude resume failed: pane returned to shell instead of entering Claude",
        recovery: "retry_fresh",
      };
    }

    return { ok: false, error: "Claude resume failed: timed out waiting for Claude to become active" };
  }

  private projectEntry(entry: ProjectionEntry, cwd: string): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, "CLAUDE.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
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
        if (this.fs.exists(dest) && hashContent(content) === hashContent(this.fs.readFile(dest))) continue;
        this.fs.mkdirp(nodePath.dirname(dest));
        this.fs.writeFile(dest, content);
      }
    } else {
      // File-shaped: single file copy (subagents, hooks as YAML files)
      const content = this.fs.readFile(entry.absolutePath);
      const destFile = nodePath.join(targetDir, nodePath.basename(entry.absolutePath));
      if (this.fs.exists(destFile) && hashContent(content) === hashContent(this.fs.readFile(destFile))) return true;
      this.fs.writeFile(destFile, content);
    }
    return true;
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
    this.provisionRigPermissions();
    this.provisionWorkspaceTrust(binding.cwd ?? null);
    this.provisionOnboardingState();
  }

  /** Managed rig command baseline.
   *  Additive only; never removes existing entries. Uses `Bash(cmd:*)`
   *  colon-form per Claude Code convention.
   *
   *  NOTE: this is not OpenRig's permission system. Harness-native
   *  permissions should remain the primary control surface. */
  static readonly CONVENIENCE_BASELINE: readonly string[] = [
    "Bash(rig:*)",
  ];

  private provisionRigPermissions(): void {
    const home = this.fs.homedir ?? (typeof process !== "undefined" ? process.env.HOME : undefined);
    if (!home) return;

    const settingsPath = nodePath.join(home, ".claude", "settings.json");
    this.fs.mkdirp(nodePath.dirname(settingsPath));

    const settings = this.readJsonObject(settingsPath);
    const permissions = this.readJsonObjectField(settings, "permissions");
    const allow = new Set(this.readStringArray(permissions["allow"]));

    // Bash convenience baseline — additive only; never removes existing entries.
    // Track whether any new patterns were actually added to avoid redundant writes
    // (preserves provenance timestamp + file content idempotency on re-runs).
    let added = 0;
    for (const pattern of ClaudeCodeAdapter.CONVENIENCE_BASELINE) {
      if (!allow.has(pattern)) {
        allow.add(pattern);
        added++;
      }
    }

    if (added === 0) return; // All patterns already present; skip write

    permissions["allow"] = Array.from(allow);
    settings["permissions"] = permissions;

    // Provenance marker so operators can distinguish rig-injected from human-authored
    settings["_openrig_provenance"] = {
      author: "openrig-at-spawn",
      baseline: "convenience",
      patterns_added: added,
      ts: new Date().toISOString(),
    };

    this.fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }

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

  private readJsonObjectField(source: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = source[key];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private readStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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

  /**
   * Best-effort: provision permissions allowlist and MCP config for managed Claude sessions.
   * Merges into .claude/settings.local.json (project-level, gitignored).
   * Idempotent: merge preserves existing settings.
   */
  private provisionPermissionsAndMcps(binding: { cwd?: string | null }): void {
    if (!binding.cwd) return;

    const settingsPath = nodePath.join(binding.cwd, ".claude", "settings.local.json");
    this.fs.mkdirp(nodePath.dirname(settingsPath));

    const existing = this.readJsonObject(settingsPath);
    const existingPermissions = this.readJsonObjectField(existing, "permissions");
    const existingAllow = this.readStringArray(existingPermissions["allow"]);
    const existingAsk = this.readStringArray(existingPermissions["ask"]);
    const existingDeny = this.readStringArray(existingPermissions["deny"]);
    const existingEnabledMcpjsonServers = this.readStringArray(existing["enabledMcpjsonServers"]);

    const rigAllowRules = [
      "Bash(rig:*)",
    ];
    const rigAskRules = [
      "Bash(rig up:*)",
      "Bash(rig down:*)",
    ];
    const legacyRigDenyRules = new Set([
      "Bash(git push*)",
      "Bash(git commit*)",
      "Bash(gh pr *)",
      "Bash(rm -rf *)",
    ]);

    // Merge without duplicating
    const mergedAllow = [...new Set([...existingAllow, ...rigAllowRules])];
    const mergedAsk = [...new Set([...existingAsk, ...rigAskRules])];
    const mergedDeny = [...new Set(existingDeny.filter((rule) => !legacyRigDenyRules.has(rule)))];
    const {
      allow: _existingAllow,
      ask: _existingAsk,
      deny: _existingDeny,
      ...otherPermissions
    } = existingPermissions;

    const permissions: Record<string, unknown> = {
      ...otherPermissions,
      defaultMode: "acceptEdits", // Unconditional: managed sessions must not inherit restrictive modes
      allow: mergedAllow,
      ask: mergedAsk,
    };
    if (mergedDeny.length > 0) {
      permissions["deny"] = mergedDeny;
    }

    existing["permissions"] = permissions;

    this.fs.writeFile(settingsPath, JSON.stringify(existing, null, 2));

    // Merge MCP config: ensure Exa and Context7 are configured at project level
    const mcpPath = nodePath.join(binding.cwd, ".mcp.json");
    const mcpConfig = this.readJsonObject(mcpPath);
    const mcpServers = this.readJsonObjectField(mcpConfig, "mcpServers");

    // Add Exa and Context7 if not already configured
    if (!mcpServers["exa"]) {
      mcpServers["exa"] = { type: "http", url: "https://mcp.exa.ai/mcp" };
    }
    if (!mcpServers["context7"]) {
      mcpServers["context7"] = { type: "http", url: "https://mcp.context7.com/mcp" };
    }

    existing["enabledMcpjsonServers"] = [...new Set([
      ...existingEnabledMcpjsonServers,
      ...Object.keys(mcpServers),
    ])];
    mcpConfig["mcpServers"] = mcpServers;

    this.fs.writeFile(settingsPath, JSON.stringify(existing, null, 2));
    this.fs.writeFile(mcpPath, JSON.stringify(mcpConfig, null, 2));
  }

  private provisionActivityHooks(binding: { cwd?: string | null }): void {
    if (!binding.cwd || !this.activityHookRelayAssetPath) return;

    const relayDest = nodePath.join(binding.cwd, ".openrig", "activity-hook-relay.cjs");
    this.fs.mkdirp(nodePath.dirname(relayDest));
    this.fs.writeFile(relayDest, this.fs.readFile(this.activityHookRelayAssetPath));

    const settingsPath = nodePath.join(binding.cwd, ".claude", "settings.local.json");
    this.fs.mkdirp(nodePath.dirname(settingsPath));
    const settings = this.readJsonObject(settingsPath);
    const hooks = this.readJsonObjectField(settings, "hooks");
    const command = `node ${shellQuote(relayDest)}`;

    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "Notification"]) {
      upsertCommandHook(hooks, event, command);
    }

    settings["hooks"] = hooks;
    this.fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Shell-quote a string using single quotes (POSIX-safe). */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

function upsertCommandHook(hooks: Record<string, unknown>, event: string, command: string): void {
  const eventEntries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
  if (eventEntries.some((entry) => hookEntryContainsCommand(entry, command))) {
    hooks[event] = eventEntries;
    return;
  }
  eventEntries.push({
    hooks: [
      { type: "command", command, timeout: 5 },
    ],
  });
  hooks[event] = eventEntries;
}

function hookEntryContainsCommand(entry: unknown, command: string): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const hooks = (entry as Record<string, unknown>)["hooks"];
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) =>
    typeof hook === "object" &&
    hook !== null &&
    !Array.isArray(hook) &&
    (hook as Record<string, unknown>)["type"] === "command" &&
    (hook as Record<string, unknown>)["command"] === command
  );
}
