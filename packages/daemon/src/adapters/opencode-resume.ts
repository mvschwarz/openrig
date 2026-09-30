// OpenCode seat resume (mirrors muse-resume.ts).
//
// Resume is HONEST session continuation: relaunch `opencode <cwd> --session
// <id>` with the persisted session id (exact-id resume — never bare
// `--continue`, which resumes the LAST session and is forbidden in managed
// paths). The seat never claims warm-process resume. A dead session id
// returns `retry_fresh`, which the restore orchestrator maps to the
// awaiting-decision stop-and-ask — never a silent fresh start.

import { setTimeout as sleep } from "node:timers/promises";
import type { TmuxAdapter } from "./tmux.js";
import type { ResumeResult } from "./claude-resume.js";
import { opencodePostureFlag } from "./yolo-mode.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { buildOpencodeResumeCommand } from "./opencode-runtime-adapter.js";
import { observeOpencodeApproval } from "../domain/permission-drift.js";

export { type ResumeResult };

const OPENCODE_TYPES = new Set(["opencode_session_id"]);
const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

interface OpencodeResumeOptions {
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class OpencodeResumeAdapter {
  constructor(
    private tmux: TmuxAdapter,
    private options: OpencodeResumeOptions = {},
  ) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    if (!resumeType || !OPENCODE_TYPES.has(resumeType)) return false;
    if (!resumeToken) return false;
    return true;
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    model?: string | null,
    // The seat's PERSISTED resolved posture (restore re-derivation);
    // absent = the env decision, unchanged.
    resolvedPosture?: "floor" | "full_bypass",
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "OpenCode resume not available" };
    }

    // Validate BEFORE anything is typed into the pane: a malformed id must
    // never reach the shell, even quoted.
    const validation = validateResumeToken("opencode", resumeToken);
    if (!validation.ok) {
      return { ok: false, code: "no_resume", message: `OpenCode resume: ${validation.error}` };
    }
    // The RESTORE path uses the SAME launch-posture decision as fresh launch
    // (harness-default floor when OFF; --auto when YOLO is ON) — every seat.
    const postureArg = opencodePostureFlag(process.env, resolvedPosture);
    const appliedLaunch = observeOpencodeApproval(postureArg);
    const cmd = buildOpencodeResumeCommand({
      sessionId: validation.token,
      cwd,
      model: model ?? undefined,
      postureArg,
    });

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

    const result = await this.verifyResume(tmuxSessionName);
    return result.ok ? { ...result, appliedLaunch } : result;
  }

  private async verifyResume(tmuxSessionName: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 200;
    const maxWaitMs = this.options.maxWaitMs ?? 5_000;
    const sleepFn = this.options.sleep ?? sleep;
    const attempts = Math.max(1, Math.floor(maxWaitMs / Math.max(pollMs, 1)) + 1);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSessionName);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
      const verdict = assessOpencodeResumeProbe(paneCommand, paneContent);

      if (verdict === "no_saved_session") {
        return {
          ok: false,
          code: "retry_fresh",
          message: "OpenCode resume failed: no saved session found for the requested id",
        };
      }

      // OpenCode auth failure is alive-but-recoverable: the operator re-runs
      // `opencode auth login` and the seat continues. Mirror Muse evidence shape.
      if (verdict === "attention_required") {
        return {
          ok: false,
          code: "attention_required",
          message: "OpenCode resume needs operator action (authentication or approval prompt is blocking)",
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }

      if (verdict === "resumed") {
        return { ok: true };
      }

      if (attempt < attempts - 1) {
        await sleepFn(pollMs);
      }
    }

    const finalCommand = await this.tmux.getPaneCommand(tmuxSessionName);
    const finalContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
    const finalVerdict = assessOpencodeResumeProbe(finalCommand, finalContent);

    if (finalVerdict === "resumed") {
      return { ok: true };
    }

    if (finalCommand && SHELL_COMMANDS.has(finalCommand)) {
      return {
        ok: false,
        code: "retry_fresh",
        message: "OpenCode resume failed: pane returned to shell instead of entering OpenCode",
      };
    }

    return {
      ok: false,
      code: "resume_failed",
      message: "OpenCode resume failed: timed out waiting for OpenCode to become active",
    };
  }
}

/** Local OpenCode resume probe (pure). Kept adapter-local — the shared
 *  native-resume-probe stays untouched (minimal shared-file edits). */
export function assessOpencodeResumeProbe(
  paneCommand: string | null,
  paneContent: string | null,
): "resumed" | "no_saved_session" | "attention_required" | "inconclusive" {
  const command = (paneCommand ?? "").trim().toLowerCase();
  const content = paneContent ?? "";

  // A dead resume id must win even inside a running TUI.
  if (/no (saved )?session found|unknown session|session (id )?not found|no such session/i.test(content)) {
    return "no_saved_session";
  }
  // A running runtime counts as resumed even when agent output contains
  // error-like text; the login markers below apply only when it does NOT
  // own the pane. Narrow auth phrases still count while it does.
  if (command === "opencode" || command.startsWith("opencode ")) {
    if (/login required|not authenticated|authentication (failed|required)|please run `?opencode (auth|login)`?/i.test(content)) {
      return "attention_required";
    }
    return "resumed";
  }
  if (/login required|not authenticated|authentication (failed|required)|please run `?opencode (auth|login)`?/i.test(content)) {
    return "attention_required";
  }
  return "inconclusive";
}
