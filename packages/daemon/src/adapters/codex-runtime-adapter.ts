import nodePath from "node:path";
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
import { mergeManagedBlock } from "../domain/managed-blocks.js";

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

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: CodexAdapterFsOps;
    listProcesses?: () => Array<{ pid: number; ppid: number; command: string }>;
    readThreadIdByPid?: (pid: number) => string | undefined;
    resolveHomeDirByPid?: ResolveHomeDirByPid;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.listProcesses = deps.listProcesses ?? defaultListProcesses;
    this.readThreadIdByPid = deps.readThreadIdByPid ?? ((pid) => this.readThreadIdFromLogs(pid));
    this.resolveHomeDirByPid = deps.resolveHomeDirByPid ?? defaultResolveHomeDirByPid;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
        this.projectEntry(entry, binding.cwd);
        projected.push(entry.effectiveId);
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? this.detectDeliveryHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            this.mergeGuidance(targetPath, file.path, content);
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

    const cmd = opts.resumeToken
      ? `codex resume ${opts.resumeToken}`
      : "codex";

    const textResult = await this.tmux.sendText(binding.tmuxSession, cmd);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }
    const enterResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
    if (!enterResult.ok) {
      return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
    }

    if (opts.resumeToken) {
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "codex_id" };
    }

    const threadId = await this.captureFreshThreadId(binding);
    if (threadId) {
      return { ok: true, resumeToken: threadId, resumeType: "codex_id" };
    }

    return { ok: true };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    return alive ? { ready: true } : { ready: false, reason: "tmux session not responsive" };
  }

  private projectEntry(entry: ProjectionEntry, cwd: string): void {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      this.mergeGuidance(targetPath, entry.effectiveId, content);
      return;
    }

    const targetDir = this.resolveTargetDir(entry, cwd);
    if (!targetDir) return;

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
      if (this.fs.exists(destFile) && hashContent(content) === hashContent(this.fs.readFile(destFile))) return;
      this.fs.writeFile(destFile, content);
    }
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

  private mergeGuidance(targetPath: string, blockId: string, content: string): void {
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
  }

  private detectDeliveryHint(path: string, content: string): "guidance_merge" | "skill_install" | "send_text" {
    return resolveConcreteHint(path, content);
  }

  private async captureFreshThreadId(binding: NodeBinding): Promise<string | undefined> {
    const target = binding.tmuxPane ?? binding.tmuxSession;
    if (!target || !this.tmux.getPanePid) return undefined;

    for (let attempt = 0; attempt < 20; attempt++) {
      const shellPid = await this.tmux.getPanePid(target);
      if (shellPid) {
        const codexPid = this.findCodexChildPid(shellPid);
        if (codexPid) {
          const threadId = this.readThreadIdByPid(codexPid);
          if (threadId) return threadId;
        }
      }
      await this.sleep(250);
    }

    return undefined;
  }

  private findCodexChildPid(parentPid: number): number | undefined {
    const processes = this.listProcesses();
    const child = processes.find((proc) => proc.ppid === parentPid && commandLooksLikeCodex(proc.command));
    return child?.pid;
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

function commandLooksLikeCodex(command: string): boolean {
  const trimmed = command.trim();
  return trimmed === "codex" || trimmed.startsWith("codex ");
}
