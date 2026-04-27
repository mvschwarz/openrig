import nodePath from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import type { TmuxAdapter } from "./tmux.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import {
  defaultResolveHomeDirByPid,
  readCodexThreadIdFromCandidateHomes,
  type ResolveHomeDirByPid,
} from "../domain/codex-thread-id.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { shellQuote } from "./shell-quote.js";

export interface CodexAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  homedir?: string;
}

/**
 * Codex runtime adapter. Projects resources to .agents/ targets (preserving
 * existing Codex filesystem contract) and delivers startup files.
 */
export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "codex";
  private tmux: TmuxAdapter;
  private fs: CodexAdapterFsOps;
  private listProcesses: () => Array<{ pid: number; ppid: number; command: string }>;
  private readThreadIdByPid: (pid: number) => string | undefined;
  private sleep: (ms: number) => Promise<void>;
  private resolveHomeDirByPid: ResolveHomeDirByPid;
  private activityHookRelayAssetPath: string | null;

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: CodexAdapterFsOps;
    listProcesses?: () => Array<{ pid: number; ppid: number; command: string }>;
    readThreadIdByPid?: (pid: number) => string | undefined;
    resolveHomeDirByPid?: ResolveHomeDirByPid;
    sleep?: (ms: number) => Promise<void>;
    activityHookRelayAssetPath?: string;
  }) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.listProcesses = deps.listProcesses ?? defaultListProcesses;
    this.readThreadIdByPid = deps.readThreadIdByPid ?? ((pid) => this.readThreadIdFromLogs(pid));
    this.resolveHomeDirByPid = deps.resolveHomeDirByPid ?? defaultResolveHomeDirByPid;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.activityHookRelayAssetPath = deps.activityHookRelayAssetPath ?? null;
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = nodePath.join(binding.cwd, ".agents", "skills");
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
      console.error(`[openrig] codex bootstrap warning: ${(err as Error).message}`);
    }

    // Best-effort: provision project-local provider hooks. The hook token is
    // supplied through tmux session env, never written to provider config.
    try { this.provisionActivityHooks(binding); } catch (err) {
      console.error(`[openrig] codex activity hook provisioning warning: ${(err as Error).message}`);
    }

    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? this.detectDeliveryHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".agents", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
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
      return { ok: false, error: "No tmux session bound — cannot launch Codex harness" };
    }

    const model = binding.model?.trim();
    const modelArg = model ? ` -m ${shellQuote(model)}` : "";
    const profile = binding.codexConfigProfile?.trim();
    const profileArg = profile ? ` -p ${shellQuote(profile)}` : "";
    const gitDirArg = ` --add-dir ${shellQuote(nodePath.join(binding.cwd, ".git"))}`;
    const queueStateDirArg = this.buildQueueStateAddDirArg(opts.name);
    const cmd = opts.resumeToken
      ? `codex${profileArg} resume${queueStateDirArg} ${shellQuote(opts.resumeToken)}`
      : profile
        ? `codex${profileArg} -C ${shellQuote(binding.cwd)}${gitDirArg}${queueStateDirArg}${modelArg}`
        : `codex -C ${shellQuote(binding.cwd)}${gitDirArg}${queueStateDirArg}${modelArg} -a never -s workspace-write`;

    const textResult = await this.tmux.sendText(binding.tmuxSession, cmd);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }
    const enterResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
    if (!enterResult.ok) {
      return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
    }

    await this.dismissSkippableCodexUpdatePrompt(binding.tmuxSession);

    if (opts.resumeToken) {
      const verification = await this.verifyResumeLaunch(binding.tmuxSession);
      if (!verification.ok) return verification;
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "codex_id" };
    }

    const threadId = await this.captureFreshThreadId(binding);
    if (threadId) {
      return { ok: true, resumeToken: threadId, resumeType: "codex_id" };
    }

    return { ok: true };
  }

  private buildQueueStateAddDirArg(sessionName: string): string {
    const identity = parseCanonicalSessionName(sessionName);
    if (!identity) return "";

    const sharedDocsRoot = process.env.OPENRIG_SHARED_DOCS_ROOT?.trim()
      || nodePath.join(this.fs.homedir ?? os.homedir(), "code", "substrate", "shared-docs");
    const queueStateRoot = nodePath.join(sharedDocsRoot, "rigs", identity.rig, "state", identity.pod);
    return ` --add-dir ${shellQuote(queueStateRoot)}`;
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
      runtime: "codex",
      paneCommand,
      paneContent,
    });

    if (probe.status === "resumed") return { ready: true };
    return { ready: false, reason: probe.detail, code: probe.code };
  }

  private async dismissSkippableCodexUpdatePrompt(tmuxSession: string, attempts = 6): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
      const probe = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand,
        paneContent,
      });

      if (probe.code === "update_gate") {
        if (!isSkippableCodexUpdatePrompt(paneContent)) return false;

        const textResult = await this.tmux.sendText(tmuxSession, "3");
        if (!textResult.ok) return false;
        const enterResult = await this.tmux.sendKeys(tmuxSession, ["Enter"]);
        if (!enterResult.ok) return false;
        await this.sleep(500);
        return true;
      }

      if (probe.status === "resumed" || probe.code === "trust_gate") {
        return false;
      }

      if (attempt < attempts - 1) {
        await this.sleep(200);
      }
    }

    return false;
  }

  ensureManagedBootstrap(binding: { cwd?: string | null }): void {
    this.provisionWorkspaceTrust(binding.cwd ?? null);
  }

  private projectEntry(entry: ProjectionEntry, cwd: string): boolean {
    if (entry.category === "runtime_resource" && this.applyRuntimeResource(entry)) {
      return true;
    }

    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    const targetDir = this.resolveTargetDir(entry, cwd);
    if (!targetDir) return true;

    this.fs.mkdirp(targetDir);
    const isDir = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath).length > 0 : false;

    if (isDir && this.fs.listFiles) {
      for (const file of this.fs.listFiles(entry.absolutePath)) {
        const src = nodePath.join(entry.absolutePath, file);
        const dest = nodePath.join(targetDir, file);
        const content = this.fs.readFile(src);
        if (this.fs.exists(dest) && hashContent(content) === hashContent(this.fs.readFile(dest))) continue;
        this.fs.mkdirp(nodePath.dirname(dest));
        this.fs.writeFile(dest, content);
      }
    } else {
      const content = this.fs.readFile(entry.absolutePath);
      const destFile = nodePath.join(targetDir, nodePath.basename(entry.absolutePath));
      if (this.fs.exists(destFile) && hashContent(content) === hashContent(this.fs.readFile(destFile))) return true;
      this.fs.writeFile(destFile, content);
    }
    return true;
  }

  private resolveTargetDir(entry: ProjectionEntry, cwd: string): string | null {
    switch (entry.category) {
      case "skill": return nodePath.join(cwd, ".agents", "skills", entry.effectiveId);
      case "guidance": return null; // handled via merge
      case "subagent": return nodePath.join(cwd, ".agents"); // .agents/{id}.yaml per preserved contract
      case "hook": return nodePath.join(cwd, ".agents", "hooks");
      case "runtime_resource": return nodePath.join(cwd, ".agents", "extensions", entry.effectiveId);
      default: return null;
    }
  }

  private applyRuntimeResource(entry: ProjectionEntry): boolean {
    if (entry.resourceType !== "codex_config_fragment") {
      return false;
    }

    const home = this.fs.homedir ?? os.homedir();
    const configPath = nodePath.join(home, ".codex", "config.toml");
    this.fs.mkdirp(nodePath.dirname(configPath));

    const existing = this.fs.exists(configPath) ? this.fs.readFile(configPath) : "";
    const fragment = this.fs.readFile(entry.absolutePath);
    this.fs.writeFile(configPath, upsertManagedCodexConfigFragment(existing, entry.effectiveId, fragment));
    return true;
  }

  /**
   * Merge a managed block into the target guidance file. Returns `true` when
   * the merge happened, `false` when intentionally skipped (rig-role). Callers
   * propagate the skip signal so ProjectionResult and StartupDeliveryResult
   * report honest counts.
   */
  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // Mirrors Claude Code adapter: the `rig-role` managed block collides across
    // pod-mates because the regenerator pairs (target-file × spec) without
    // seat correlation. Per-seat role content is delivered through `send_text`
    // startup instead. Refuse the merge loudly; silent skip would mask the
    // collision. See ADR-0006.
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

  private detectDeliveryHint(path: string, content: string): "guidance_merge" | "skill_install" | "send_text" {
    return resolveConcreteHint(path, content);
  }

  private provisionWorkspaceTrust(cwd: string | null): void {
    if (!cwd) return;
    const home = this.fs.homedir ?? os.homedir();
    if (!home) return;

    const configPath = nodePath.join(home, ".codex", "config.toml");
    this.fs.mkdirp(nodePath.dirname(configPath));

    let content = "";
    try {
      if (this.fs.exists(configPath)) content = this.fs.readFile(configPath);
    } catch {
      content = "";
    }

    for (const trustKey of this.workspaceTrustKeys(cwd)) {
      content = upsertCodexProjectTrust(content, trustKey);
    }

    this.fs.writeFile(configPath, content);
  }

  private provisionActivityHooks(binding: { cwd?: string | null }): void {
    if (!binding.cwd || !this.activityHookRelayAssetPath) return;

    const relayDest = nodePath.join(binding.cwd, ".openrig", "activity-hook-relay.cjs");
    this.fs.mkdirp(nodePath.dirname(relayDest));
    this.fs.writeFile(relayDest, this.fs.readFile(this.activityHookRelayAssetPath));

    const codexDir = nodePath.join(binding.cwd, ".codex");
    this.fs.mkdirp(codexDir);

    const hooksPath = nodePath.join(codexDir, "hooks.json");
    const hooksConfig = this.readJsonObject(hooksPath);
    const hooks = this.readJsonObjectField(hooksConfig, "hooks");
    const command = `node ${shellQuote(relayDest)}`;
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      upsertCommandHook(hooks, event, command);
    }
    hooksConfig["hooks"] = hooks;
    this.fs.writeFile(hooksPath, `${JSON.stringify(hooksConfig, null, 2)}\n`);

    const configPath = nodePath.join(codexDir, "config.toml");
    const existingConfig = this.fs.exists(configPath) ? this.fs.readFile(configPath) : "";
    this.fs.writeFile(configPath, upsertCodexHooksFeature(existingConfig));
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

  private workspaceTrustKeys(cwd: string): string[] {
    const keys = new Set<string>([nodePath.resolve(cwd)]);
    try {
      keys.add(fs.realpathSync.native(cwd));
    } catch {
      // Best-effort only.
    }
    return Array.from(keys);
  }

  private async captureFreshThreadId(binding: NodeBinding): Promise<string | undefined> {
    const target = binding.tmuxPane ?? binding.tmuxSession;
    if (!target || !this.tmux.getPanePid) return undefined;

    for (let attempt = 0; attempt < 20; attempt++) {
      const shellPid = await this.tmux.getPanePid(target);
      if (shellPid) {
        const codexPids = this.findCodexDescendantPids(shellPid);
        for (const codexPid of codexPids) {
          const threadId = this.readThreadIdByPid(codexPid);
          if (threadId) return threadId;
        }
      }
      if (binding.tmuxSession) {
        await this.dismissSkippableCodexUpdatePrompt(binding.tmuxSession, 1);
      }
      await this.sleep(250);
    }

    return undefined;
  }

  private async verifyResumeLaunch(tmuxSession: string): Promise<HarnessLaunchResult> {
    const attempts = 6;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
      const probe = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand,
        paneContent,
      });

      if (probe.code === "no_saved_session") {
        return {
          ok: false,
          error: "Codex resume failed: no saved session found for the requested session",
          recovery: "retry_fresh",
        };
      }

      if (probe.code === "returned_to_shell") {
        return {
          ok: false,
          error: "Codex resume failed: pane returned to shell instead of entering Codex",
          recovery: "retry_fresh",
        };
      }

      if (probe.status === "resumed") {
        return { ok: true };
      }

      if (probe.code === "update_gate") {
        const dismissed = await this.dismissSkippableCodexUpdatePrompt(tmuxSession, 1);
        if (dismissed) {
          if (attempt < attempts - 1) {
            await this.sleep(200);
          }
          continue;
        }
        return { ok: true };
      }

      if (probe.code === "trust_gate") {
        return { ok: true };
      }

      if (attempt < attempts - 1) {
        await this.sleep(200);
      }
    }

    return { ok: true };
  }

  private findCodexDescendantPids(parentPid: number): number[] {
    const processes = this.listProcesses();
    return findCodexDescendantPids(processes, parentPid);
  }

  private readThreadIdFromLogs(pid: number): string | undefined {
    return readCodexThreadIdFromCandidateHomes(
      pid,
      [this.resolveHomeDirByPid(pid), this.fs.homedir, os.homedir()],
      (path) => this.fs.exists(path)
    );
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function upsertCodexProjectTrust(content: string, projectPath: string): string {
  const header = `[projects.${JSON.stringify(projectPath)}]`;
  const lines = content.length > 0 ? content.split("\n") : [];
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex === -1) {
    const trimmed = content.trimEnd();
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
    return `${prefix}${header}\ntrust_level = "trusted"\n`;
  }

  let nextSectionIndex = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) {
      nextSectionIndex = i;
      break;
    }
  }

  const trustIndex = lines.findIndex((line, index) => index > headerIndex && index < nextSectionIndex && line.trim().startsWith("trust_level"));
  if (trustIndex >= 0) {
    lines[trustIndex] = 'trust_level = "trusted"';
  } else {
    lines.splice(headerIndex + 1, 0, 'trust_level = "trusted"');
  }

  return `${lines.join("\n").replace(/\n*$/, "\n")}`;
}

function parseCanonicalSessionName(sessionName: string): { pod: string; member: string; rig: string } | null {
  const trimmed = sessionName.trim();
  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 0 || atIndex !== trimmed.lastIndexOf("@") || atIndex === trimmed.length - 1) return null;

  const local = trimmed.slice(0, atIndex);
  const rig = trimmed.slice(atIndex + 1);
  const separatorIndex = local.indexOf("-");
  if (separatorIndex <= 0 || separatorIndex === local.length - 1) return null;

  const pod = local.slice(0, separatorIndex);
  const member = local.slice(separatorIndex + 1);
  if (!isSafeQueueSegment(pod) || !isSafeQueueSegment(member) || !isSafeQueueSegment(rig)) return null;

  return { pod, member, rig };
}

function isSafeQueueSegment(segment: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment);
}

function upsertCodexHooksFeature(content: string): string {
  const lines = content.length > 0 ? content.replace(/\n*$/, "").split("\n") : [];
  const featuresIndex = lines.findIndex((line) => line.trim() === "[features]");

  if (featuresIndex === -1) {
    const prefix = lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
    return `${prefix}[features]\ncodex_hooks = true\n`;
  }

  let nextSectionIndex = lines.length;
  for (let i = featuresIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) {
      nextSectionIndex = i;
      break;
    }
  }

  const flagIndex = lines.findIndex((line, index) =>
    index > featuresIndex &&
    index < nextSectionIndex &&
    line.trim().startsWith("codex_hooks")
  );
  if (flagIndex >= 0) {
    lines[flagIndex] = "codex_hooks = true";
  } else {
    lines.splice(featuresIndex + 1, 0, "codex_hooks = true");
  }

  return `${lines.join("\n")}\n`;
}

function upsertManagedCodexConfigFragment(content: string, id: string, fragment: string): string {
  const start = `# BEGIN OPENRIG MANAGED CODEX CONFIG FRAGMENT: ${id}`;
  const end = `# END OPENRIG MANAGED CODEX CONFIG FRAGMENT: ${id}`;
  const block = `${start}\n${fragment.replace(/\n*$/, "")}\n${end}\n`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m");

  if (pattern.test(content)) {
    return content.replace(pattern, block);
  }

  const prefix = content.replace(/\n*$/, "");
  return prefix.length > 0 ? `${prefix}\n\n${block}` : block;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function defaultListProcesses(): Array<{ pid: number; ppid: number; command: string }> {
  try {
    const output = execFileSync("ps", ["-Ao", "pid,ppid,command"], { encoding: "utf-8" });
    return output
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          command: match[3] ?? "",
        };
      })
      .filter((row): row is { pid: number; ppid: number; command: string } => row !== null);
  } catch {
    return [];
  }
}

function findCodexDescendantPids(
  processes: Array<{ pid: number; ppid: number; command: string }>,
  parentPid: number
): number[] {
  const childrenByParent = new Map<number, Array<{ pid: number; command: string }>>();
  for (const proc of processes) {
    const siblings = childrenByParent.get(proc.ppid) ?? [];
    siblings.push({ pid: proc.pid, command: proc.command });
    childrenByParent.set(proc.ppid, siblings);
  }

  const matches: number[] = [];
  const visit = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      visit(child.pid);
      if (commandLooksLikeCodex(child.command)) {
        matches.push(child.pid);
      }
    }
  };

  visit(parentPid);
  return matches;
}

function commandLooksLikeCodex(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  return tokens.some((token) => {
    const unquoted = token.replace(/^['"]|['"]$/g, "");
    const base = nodePath.basename(unquoted);
    return base === "codex";
  });
}

function isSkippableCodexUpdatePrompt(paneContent: string): boolean {
  return paneContent.includes("Update available!")
    && paneContent.includes("Skip until next version");
}
