import nodePath from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import type { TmuxAdapter } from "./tmux.js";
import { agyPostureFlag } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { observeAgyPermission } from "../domain/permission-drift.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { shellQuote } from "./shell-quote.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface AgyAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
  homedir?: string;
}

export interface AgyRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: AgyAdapterFsOps;
  dbPath?: string;
  homedir?: string;
  launchPath?: string;
  sleep?: (ms: number) => Promise<void>;
  captureConversationId?: (cwd: string, sinceEpochMs?: number) => Promise<string | null> | string | null;
}

export function defaultCaptureAgyConversationId(
  dbPath: string,
  cwd: string,
): string | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(
        "SELECT conversation_id, last_modified_time, workspace_uris FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 10"
      ).all() as Array<{ conversation_id: string; last_modified_time: string; workspace_uris: string }>;

      const resolvedCwd = nodePath.resolve(cwd);
      const cwdUri = `file://${resolvedCwd}`;
      for (const row of rows) {
        if (row.workspace_uris && row.workspace_uris.includes(cwdUri)) {
          return row.conversation_id;
        }
      }
      if (rows.length > 0 && rows[0]?.conversation_id) {
        return rows[0].conversation_id;
      }
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
  return null;
}

export class AgyRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "agy";
  private tmux: TmuxAdapter;
  private fs: AgyAdapterFsOps;
  private dbPath: string;
  private launchPath?: string;
  private sleep: (ms: number) => Promise<void>;
  private captureConvId: (cwd: string, sinceEpochMs?: number) => Promise<string | null> | string | null;

  constructor(deps: AgyRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    const home = deps.homedir ?? os.homedir();
    this.dbPath = deps.dbPath ?? nodePath.join(home, ".gemini", "antigravity-cli", "conversation_summaries.db");
    this.launchPath = deps.launchPath;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.captureConvId = deps.captureConversationId ?? ((cwd) => defaultCaptureAgyConversationId(this.dbPath, cwd));
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
        if (this.projectEntry(entry, binding.cwd)) {
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
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue;
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

    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch Antigravity harness" };
    }

    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }

    if (opts.forkSource) {
      return { ok: false, error: "agy fork is not supported in v1" };
    }

    const model = binding.model?.trim();
    const modelArg = model ? ` --model ${shellQuote(model)}` : "";
    const postureArg = agyPostureFlag(process.env, binding.launchPosture);
    const appliedLaunch = observeAgyPermission(postureArg);

    if (opts.resumeToken) {
      const validation = validateResumeToken("agy", opts.resumeToken);
      if (!validation.ok) {
        return { ok: false, error: `agy resume: ${validation.error}` };
      }

      const cmd = `agy${postureArg}${modelArg} --conversation ${shellQuote(opts.resumeToken)}`;
      const textResult = await this.tmux.sendShellCommand(
        binding.tmuxSession,
        this.launchPath ? `env PATH=${shellQuote(this.launchPath)} ${cmd}` : cmd,
      );
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
      }

      const verification = await this.verifyResumeLaunch(binding.tmuxSession);
      if (!verification.ok) return verification;
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "agy_id", appliedLaunch };
    }

    const startTime = Date.now();
    const cmd = `agy${postureArg}${modelArg}`;
    const textResult = await this.tmux.sendShellCommand(
      binding.tmuxSession,
      this.launchPath ? `env PATH=${shellQuote(this.launchPath)} ${cmd}` : cmd,
    );
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }

    // Capture conversation ID (poll up to 5 times)
    let token: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      token = await this.captureConvId(binding.cwd, startTime);
      if (token) break;
      await this.sleep(250);
    }

    return { ok: true, resumeToken: token ?? undefined, resumeType: "agy_id", appliedLaunch };
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
      runtime: "agy",
      paneCommand,
      paneContent,
    });

    if (probe.status === "resumed") return { ready: true };
    return { ready: false, reason: probe.detail, code: probe.code };
  }

  private async verifyResumeLaunch(tmuxSession: string): Promise<HarnessLaunchResult> {
    const attempts = 16;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
      const probe = assessNativeResumeProbe({
        runtime: "agy",
        paneCommand,
        paneContent,
      });

      if (probe.code === "no_conversation_found") {
        return {
          ok: false,
          error: "Agy resume failed: no conversation found for the requested session",
          recovery: "retry_fresh",
        };
      }

      if (probe.status === "resumed") {
        return { ok: true };
      }

      if (probe.status === "attention_required") {
        return {
          ok: false,
          error: probe.detail,
          recovery: "attention_required",
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }

      if (attempt < attempts - 1) {
        await this.sleep(200);
      }
    }

    const finalCommand = await this.tmux.getPaneCommand(tmuxSession);
    const finalContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
    const finalProbe = assessNativeResumeProbe({
      runtime: "agy",
      paneCommand: finalCommand,
      paneContent: finalContent,
    });

    if (finalProbe.status === "resumed") {
      return { ok: true };
    }

    if (finalCommand && SHELL_COMMANDS.has(finalCommand)) {
      return {
        ok: false,
        error: "Agy resume failed: pane returned to shell instead of entering agy",
        recovery: "retry_fresh",
      };
    }

    return { ok: false, error: "Agy resume failed: timed out waiting for agy to become active" };
  }

  private projectEntry(entry: ProjectionEntry, cwd: string): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    if (entry.category === "skill") {
      const targetDir = nodePath.join(cwd, ".agents", "skills", entry.effectiveId);
      this.fs.mkdirp(targetDir);
      const isDir = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath).length > 0 : false;
      if (isDir && this.fs.listFiles) {
        for (const file of this.fs.listFiles(entry.absolutePath)) {
          const dest = nodePath.join(targetDir, file);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.fs.writeFile(dest, this.fs.readFile(nodePath.join(entry.absolutePath, file)));
        }
      } else {
        this.fs.writeFile(
          nodePath.join(targetDir, nodePath.basename(entry.absolutePath)),
          this.fs.readFile(entry.absolutePath),
        );
      }
      return true;
    }

    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
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
}
