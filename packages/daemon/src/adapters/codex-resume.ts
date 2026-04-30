import { setTimeout as sleep } from "node:timers/promises";
import type { TmuxAdapter } from "./tmux.js";
import type { ResumeResult } from "./claude-resume.js";
import { shellQuote } from "./shell-quote.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";

const CODEX_TYPES = new Set(["codex_id", "codex_last"]);
const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export { type ResumeResult };

interface CodexResumeOptions {
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class CodexResumeAdapter {
  constructor(
    private tmux: TmuxAdapter,
    private options: CodexResumeOptions = {}
  ) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    if (!resumeType || !CODEX_TYPES.has(resumeType)) return false;
    // codex_last does not need a token
    if (resumeType === "codex_last") return true;
    // codex_id needs a token
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
      return { ok: false, code: "no_resume", message: "Codex resume not available" };
    }

    const cmd = resumeType === "codex_last"
      ? "codex resume --last"
      : `codex resume ${shellQuote(resumeToken!)}`;

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

  // Mirrors ClaudeResumeAdapter.verifyResume: poll the pane, run the native
  // probe, return resumed / retry_fresh / attention_required / resume_failed
  // based on observable runtime state. The `attention_required` outcome
  // (Codex auth refusal — stored OAuth token can no longer be refreshed)
  // closes the deferral recorded by the lifecycle scenario matrix slice.
  private async verifyResume(tmuxSessionName: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 200;
    const maxWaitMs = this.options.maxWaitMs ?? 5_000;
    const sleepFn = this.options.sleep ?? sleep;
    const attempts = Math.max(1, Math.floor(maxWaitMs / Math.max(pollMs, 1)) + 1);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSessionName);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
      const probe = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand,
        paneContent,
      });

      if (probe.code === "no_saved_session") {
        return {
          ok: false,
          code: "retry_fresh",
          message: "Codex resume failed: no saved session found for the requested token",
        };
      }

      // Codex auth-refusal is alive-but-recoverable: the stored access token
      // can no longer be refreshed. Surface evidence (last 12 pane lines) so
      // the operator/UI can decide whether to `codex login` and continue, or
      // mark the seat permanently rebuilt. Mirror Claude's evidence shape.
      if (probe.status === "attention_required") {
        return {
          ok: false,
          code: "attention_required",
          message: probe.detail,
          evidence: paneContent.split("\n").slice(-12).join("\n"),
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
      runtime: "codex",
      paneCommand: finalCommand,
      paneContent: finalContent,
    });

    if (finalProbe.status === "resumed") {
      return { ok: true };
    }

    if (finalCommand && SHELL_COMMANDS.has(finalCommand)) {
      return {
        ok: false,
        code: "retry_fresh",
        message: "Codex resume failed: pane returned to shell instead of entering Codex",
      };
    }

    return {
      ok: false,
      code: "resume_failed",
      message: "Codex resume failed: timed out waiting for Codex to become active",
    };
  }
}
