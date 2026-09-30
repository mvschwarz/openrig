// Muse seat resume (mirrors claude-resume.ts / codex-resume.ts).
//
// Resume is HONEST session continuation: relaunch `muse resume <id>` with the
// persisted session id (exact-id resume — never an interactive picker). The
// seat never claims warm-process resume. A dead session id returns
// `retry_fresh`, which the restore orchestrator maps to the awaiting-decision
// stop-and-ask — never a silent fresh start.

import { setTimeout as sleep } from "node:timers/promises";
import type { TmuxAdapter } from "./tmux.js";
import type { ResumeResult } from "./claude-resume.js";
import { musePostureFlag } from "./yolo-mode.js";
import { buildMuseResumeCommand } from "./muse-runtime-adapter.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { observeMuseTrust } from "../domain/permission-drift.js";

export { type ResumeResult };

const MUSE_TYPES = new Set(["muse_id"]);
const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

interface MuseResumeOptions {
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class MuseResumeAdapter {
  constructor(
    private tmux: TmuxAdapter,
    private options: MuseResumeOptions = {},
  ) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    if (!resumeType || !MUSE_TYPES.has(resumeType)) return false;
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
      return { ok: false, code: "no_resume", message: "Muse resume not available" };
    }

    // Validate BEFORE anything is typed into the pane: a malformed id must
    // never reach the shell, even quoted.
    const validation = validateResumeToken("muse", resumeToken);
    if (!validation.ok) {
      return { ok: false, code: "no_resume", message: `Muse resume: ${validation.error}` };
    }
    // The RESTORE path uses the SAME launch-posture decision as fresh launch
    // (harness-default floor when OFF; --yolo when YOLO is ON) — every seat.
    const postureArg = musePostureFlag(process.env, resolvedPosture);
    const appliedLaunch = observeMuseTrust(postureArg);
    const cmd = buildMuseResumeCommand({
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
      const verdict = assessMuseResumeProbe(paneCommand, paneContent);

      if (verdict === "no_saved_session") {
        return {
          ok: false,
          code: "retry_fresh",
          message: "Muse resume failed: no saved session found for the requested id",
        };
      }

      // Muse auth failure is alive-but-recoverable: the operator re-runs
      // `muse login` and the seat continues. Mirror Claude/Codex evidence shape.
      if (verdict === "attention_required") {
        return {
          ok: false,
          code: "attention_required",
          message: "Muse resume needs operator action (authentication or approval prompt is blocking)",
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
    const finalVerdict = assessMuseResumeProbe(finalCommand, finalContent);

    if (finalVerdict === "resumed") {
      return { ok: true };
    }

    if (finalCommand && SHELL_COMMANDS.has(finalCommand)) {
      return {
        ok: false,
        code: "retry_fresh",
        message: "Muse resume failed: pane returned to shell instead of entering Muse",
      };
    }

    return {
      ok: false,
      code: "resume_failed",
      message: "Muse resume failed: timed out waiting for Muse to become active",
    };
  }
}

/** Local Muse resume probe (pure). Kept adapter-local — the shared
 *  native-resume-probe stays untouched (minimal shared-file edits). */
export function assessMuseResumeProbe(
  paneCommand: string | null,
  paneContent: string | null,
): "resumed" | "no_saved_session" | "attention_required" | "inconclusive" {
  const command = (paneCommand ?? "").trim().toLowerCase();
  const content = paneContent ?? "";

  // A dead resume id must win even inside a running TUI.
  if (/no (saved )?session found|unknown session|session (id )?not found/i.test(content)) {
    return "no_saved_session";
  }
  // The `muse` launcher execs a versioned `muse-bin-<version>` child (same
  // as the fresh-launch probe): tmux reports e.g. `muse-bin-1.3.0-R3401.1`.
  // A running runtime counts as resumed even when agent output contains
  // error-like text; the markers below apply only when it does NOT own the
  // pane. Narrow auth phrases still count while it does.
  if (command === "muse" || command.startsWith("muse ") || command.startsWith("muse-bin")) {
    if (/login required|not authenticated|authentication (failed|required)|please run `?muse login`?/i.test(content)) {
      return "attention_required";
    }
    return "resumed";
  }
  if (/login required|not authenticated|authentication (failed|required)|please run `?muse login`?/i.test(content)) {
    return "attention_required";
  }
  return "inconclusive";
}
