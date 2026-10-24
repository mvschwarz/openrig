import type { TmuxAdapter } from "./tmux.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan } from "../domain/projection-planner.js";
import { shellQuote } from "./shell-quote.js";
import * as nodePath from "node:path";

export interface PrimeAgentAdapterFsOps {
  readFile(path: string): string;
  exists(path: string): boolean;
  mkdirp?(path: string): void;
  copyFile?(src: string, dest: string): void;
  readdir?(dir: string): string[];
}

/** Prime Agent runtime adapter.
 *  Launches prime-agent REPL sessions in tmux, delivers guidance via send_text,
 *  and lets the agent read skills from .agents/skills/ in the seat cwd
 *  (skill projection is a no-op ack: the runtime reads the project tree itself). */
export class PrimeAgentAdapter implements RuntimeAdapter {
  readonly runtime = "prime-agent";

  constructor(
    private readonly opts: { tmux: TmuxAdapter; seatLaunchEnvironment?: unknown; fsOps: PrimeAgentAdapterFsOps },
  ) {}

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const skillsDir = nodePath.join(binding.cwd, ".agents", "skills");
    const installed: InstalledResource[] = [];
    try {
      const entries = this.opts.fsOps.readdir ? this.opts.fsOps.readdir(skillsDir) : [];
      for (const e of entries) {
        const skillPath = nodePath.join(skillsDir, e, "SKILL.md");
        if (this.opts.fsOps.exists(skillPath)) {
          installed.push({ effectiveId: e, category: "skill", installedPath: skillPath });
        }
      }
    } catch {
      // no .agents/skills dir: nothing projected yet
    }
    return installed;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    // prime-agent reads skills from .agents/skills/ in the seat cwd. Report an
    // entry as projected only once its SKILL.md actually exists at the runtime
    // target; anything missing is surfaced as failed rather than silently
    // acknowledged.
    const projected: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];
    for (const e of plan.entries ?? []) {
      const target = nodePath.join(binding.cwd, ".agents", "skills", e.effectiveId, "SKILL.md");
      if (this.opts.fsOps.exists(target)) {
        projected.push(e.effectiveId);
      } else {
        failed.push({ effectiveId: e.effectiveId, error: `skill not materialized at runtime target: ${target}` });
      }
    }
    return { projected, skipped: [], failed };
  }

  async deliverStartup(
    files: ResolvedStartupFile[],
    binding: NodeBinding,
    sendInteractiveText?: (text: string) => Promise<void>,
  ): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: StartupDeliveryResult["failed"] = [];
    const warnings: string[] = [];
    for (const file of files) {
      const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, "") : file.deliveryHint;
      try {
        let content: string;
        try {
          content = this.opts.fsOps.readFile(file.absolutePath);
        } catch {
          if (file.required) {
            failed.push({ path: file.path, error: `cannot read ${file.absolutePath}` });
            continue;
          }
          warnings.push(`skipped optional ${file.path}: unreadable`);
          continue;
        }
        if (hint === "send_text") {
          // Interactive delivery requires the callback; without it a required
          // file is a failure and an optional file is a warning — never count
          // as delivered.
          if (!sendInteractiveText) {
            if (file.required) {
              failed.push({ path: file.path, error: "no interactive channel available" });
            } else {
              warnings.push(`optional ${file.path}: no interactive channel available`);
            }
            continue;
          }
          await sendInteractiveText(content);
          delivered++;
        } else {
          // guidance_merge / skill_install: prime-agent reads these from disk on
          // its own; deliver the absolute path so the agent can resolve files
          // that live outside binding.cwd.
          if (sendInteractiveText) {
            await sendInteractiveText(`Read ${file.absolutePath} before doing anything else.`);
          }
          delivered++;
        }
      } catch (err) {
        if (file.required) {
          failed.push({ path: file.path, error: (err as Error).message });
        } else {
          warnings.push(`optional ${file.path} failed: ${(err as Error).message}`);
        }
      }
    }
    return { delivered, failed, warnings };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: unknown; freshInPlace?: boolean },
  ): Promise<HarnessLaunchResult> {
    if (opts.forkSource) {
      return { ok: false, error: "prime-agent: fork is not supported in v1; use --resume via terminal" };
    }
    if (opts.resumeToken) {
      return { ok: false, error: "prime-agent: native resume tokens are not captured in v1; seat relaunches fresh" };
    }
    const model = binding.model?.trim();
    const effort = binding.effort?.trim();
    const modelArg = model ? ` --model ${shellQuote(model)}` : "";
    const effortArg = effort ? ` --thinking ${shellQuote(effort)}` : "";
    if (binding.tmuxSession == null) {
      return { ok: false, error: "prime-agent: seat has no tmux session bound" };
    }
    const cmd = `prime-agent --thinking low${modelArg}${effortArg}`;
    try {
      const textResult = await this.opts.tmux.sendText(binding.tmuxSession, cmd);
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch text: ${textResult.message}` };
      }
      const enterResult = await this.opts.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
      if (!enterResult.ok) {
        return { ok: false, error: `Failed to press Enter: ${enterResult.message}` };
      }
    } catch (err) {
      return { ok: false, error: `Launch failed: ${(err as Error).message}` };
    }
    return { ok: true };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (binding.tmuxSession == null) {
      return { ready: false, reason: "seat has no tmux session bound", code: "pane_error" };
    }
    try {
      const content = (await this.opts.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
      if (!content) {
        return { ready: false, reason: "pane is empty", code: "pane_empty" };
      }
      // Only TUI-specific signals count as ready. The echoed launch command
      // (e.g. `prime-agent --thinking low`) is stripped from consideration so a
      // failed/exited launch can never satisfy readiness, and a shell prompt
      // means the harness never started.
      const lines = content.split("\n").filter((l) => !l.includes("prime-agent --"));
      const pane = lines.join("\n");
      const tuiSignal =
        pane.includes("\u2190 manage") ||          // left manage-prompt marker drawn by the TUI
        /\u00b7\s*\d+%/.test(pane);               // status-bar model separator followed by a percent token
      if (tuiSignal) {
        return { ready: true };
      }
      if (pane.includes("$") || pane.includes(">")) {
        return { ready: false, reason: "shell prompt visible; agent not launched", code: "not_launched" };
      }
      return { ready: false, reason: "unknown pane state", code: "unknown" };
    } catch (err) {
      return { ready: false, reason: (err as Error).message, code: "pane_error" };
    }
  }
}
