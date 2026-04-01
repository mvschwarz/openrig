import { setTimeout as sleep } from "node:timers/promises";
import type { TmuxAdapter } from "./tmux.js";
import { shellQuote } from "./shell-quote.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";

export type ResumeResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

const CLAUDE_TYPES = new Set(["claude_name", "claude_id"]);
const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

interface ClaudeResumeOptions {
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class ClaudeResumeAdapter {
  constructor(
    private tmux: TmuxAdapter,
    private options: ClaudeResumeOptions = {}
  ) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    if (!resumeType || !CLAUDE_TYPES.has(resumeType)) return false;
    if (!resumeToken) return false;
    return true;
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    _cwd: string
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "Claude resume not available" };
    }

    const cmd = `claude --resume ${shellQuote(resumeToken!)}`;

    const textResult = await this.tmux.sendText(tmuxSessionName, cmd);
    if (!textResult.ok) {
      // sendText failed — nothing in the buffer, no cleanup needed
      return { ok: false, code: "resume_failed", message: textResult.message };
    }

    const keyResult = await this.tmux.sendKeys(tmuxSessionName, ["Enter"]);
    if (!keyResult.ok) {
      // Partial failure: command text is in the buffer but Enter failed.
      // Best-effort cleanup: send C-c to clear the typed command.
      await this.tmux.sendKeys(tmuxSessionName, ["C-c"]);
      return { ok: false, code: "resume_failed", message: keyResult.message };
    }

    return this.verifyResume(tmuxSessionName);
  }

  private async verifyResume(tmuxSessionName: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 200;
    const maxWaitMs = this.options.maxWaitMs ?? 3_000;
    const sleepFn = this.options.sleep ?? sleep;
    const attempts = Math.max(1, Math.floor(maxWaitMs / Math.max(pollMs, 1)) + 1);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSessionName);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
      const probe = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand,
        paneContent,
      });

      if (probe.code === "no_conversation_found") {
        return {
          ok: false,
          code: "resume_failed",
          message: "Claude resume failed: no conversation found for the requested session",
        };
      }

      if (probe.status === "resumed") {
        return { ok: true };
      }

      if (attempt < attempts - 1) {
        await sleepFn(pollMs);
      }
    }

    const finalCommand = await this.tmux.getPaneCommand(tmuxSessionName);
    const finalContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
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
        code: "resume_failed",
        message: "Claude resume failed: pane returned to shell instead of entering Claude",
      };
    }

    return {
      ok: false,
      code: "resume_failed",
      message: "Claude resume failed: timed out waiting for Claude to become active",
    };
  }
}
