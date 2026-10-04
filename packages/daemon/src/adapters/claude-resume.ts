import { setTimeout as sleep } from "node:timers/promises";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import { shellQuote } from "./shell-quote.js";
import { claudePostureFlag, claudeClassicRendererEnvPrefix } from "./yolo-mode.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { verifyClaudePaneProcess, type NativeProcessLister } from "../domain/native-process-lineage.js";
import { observeClaudePermission, type AppliedLaunchObservation } from "../domain/permission-drift.js";
import { unresolvedClaudePermissionModes } from "../domain/native-permission-selection.js";
import type { ClaudeManagedLaunch } from "../domain/claude-managed-launch.js";

export type ResumeResult =
  | { ok: true; appliedLaunch?: AppliedLaunchObservation }
  // Non-terminal: a chooser or an inconclusive observation must preserve the
  // launch. Attention is not proof of native identity or successful continuity.
  | { ok: false; code: "attention_required"; message: string; evidence?: string }
  | { ok: false; code: string; message: string };

const CLAUDE_TYPES = new Set(["claude_name", "claude_id"]);

/** The legacy name and native ID are both supported Claude resume inputs. */
export function isClaudeResumeType(resumeType: string | null | undefined): boolean {
  return resumeType != null && CLAUDE_TYPES.has(resumeType);
}

interface ClaudeResumeOptions {
  seatLaunchEnvironment?: SeatLaunchEnvironment;
  claudeManagedLaunch?: ClaudeManagedLaunch;
  listProcesses?: NativeProcessLister;
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
    if (!isClaudeResumeType(resumeType)) return false;
    if (!resumeToken) return false;
    return true;
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    // OPR.0.4.8.3 Seam B: the seat's PERSISTED resolved posture (restore re-derivation);
    // absent = the env decision (0.4.8.2), unchanged.
    resolvedPosture?: "floor" | "full_bypass" | "auto",
    // 0.5.2-07: the seat's SPEC-pinned model. TRAILING param so existing positional callers that pass
    // resolvedPosture as the 5th arg stay correct; threaded so the legacy (non-pod-aware) restore boots
    // the resumed seat on its spec model, not the runtime default; absent → command byte-identical.
    model?: string | null,
    selectedPermissionMode?: string,
    nodeId?: string,
    effort?: string | null,
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "Claude resume not available" };
    }

    // OPR.0.4.8.2: the RESTORE path uses the SAME launch-posture decision as fresh launch (the
    // unconditional acceptEdits floor when OFF; the full bypass when YOLO is ON) — every seat.
    // 0.5.2-07: --model matches the fresh-launch adapter (claude-code-adapter), emitted after posture.
    const modelArg = model ? ` --model ${shellQuote(model)}` : "";
    const effortArg = effort ? ` --effort ${shellQuote(effort)}` : "";
    let managed: Awaited<ReturnType<ClaudeManagedLaunch["prepare"]>> | undefined;
    if (selectedPermissionMode !== undefined) {
      try {
        if (!nodeId || !this.options.claudeManagedLaunch) await unresolvedClaudePermissionModes();
        managed = await this.options.claudeManagedLaunch!.prepare({ nodeId: nodeId!, cwd, session: tmuxSessionName }, selectedPermissionMode);
      } catch (error) { return { ok: false, code: "permission_selection_refused", message: (error as Error).message }; }
    }
    const permissionMode = claudePostureFlag(process.env, resolvedPosture, selectedPermissionMode);
    const appliedLaunch = observeClaudePermission(permissionMode);
    const cmd = managed ? managed.command(["--permission-mode", selectedPermissionMode!, ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), "--resume", resumeToken!])
      : `${claudeClassicRendererEnvPrefix(process.env)}claude ${permissionMode}${modelArg}${effortArg} --resume ${shellQuote(resumeToken!)}`;

    const textResult = managed ? await this.tmux.sendShellCommand(tmuxSessionName, cmd, managed.assertCurrent)
      : this.options.seatLaunchEnvironment
        ? await this.tmux.sendShellCommand(tmuxSessionName, await this.options.seatLaunchEnvironment.command(tmuxSessionName, cmd, { runtime: "claude-code", nodeId }), undefined, { sourceInPane: true })
        : await this.tmux.sendText(tmuxSessionName, cmd);
    if (!textResult.ok) {
      // sendText failed — nothing in the buffer, no cleanup needed
      return { ok: false, code: "resume_failed", message: textResult.message };
    }

    const keyResult = managed || this.options.seatLaunchEnvironment ? { ok: true as const } : await this.tmux.sendKeys(tmuxSessionName, ["Enter"]);
    if (!keyResult.ok) {
      // Partial failure: command text is in the buffer but Enter failed.
      // Best-effort cleanup: send C-c to clear the typed command.
      await this.tmux.sendKeys(tmuxSessionName, ["C-c"]);
      return { ok: false, code: "resume_failed", message: keyResult.message };
    }

    const result = await this.verifyResume(tmuxSessionName, resumeToken!).catch((error): ResumeResult => ({
      ok: false,
      code: "attention_required",
      message: `Claude resume observation unavailable; launch retained: ${error instanceof Error ? error.message : String(error)}`,
    }));
    return result.ok ? { ...result, appliedLaunch } : result;
  }

  private async verifyResume(tmuxSessionName: string, resumeToken: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 200;
    const maxWaitMs = this.options.maxWaitMs ?? 5_000;
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
          code: "retry_fresh",
          message: "Claude resume failed: no conversation found for the requested session",
        };
      }

      // L3: Claude resume-selection prompt → attention_required (not failed).
      // The runtime is alive and recoverable but blocked on operator selection.
      // Decision 2 forbids auto-answering; surface evidence and let the
      // operator/UI act, then later reconciliation may upgrade to
      // operator_recovered when the pane reaches usable state.
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
      runtime: "claude-code",
      paneCommand: finalCommand,
      paneContent: finalContent,
    });

    if (finalProbe.code === "no_conversation_found") {
      return { ok: false, code: "retry_fresh", message: "Claude resume failed: no conversation found for the requested session" };
    }
    if (finalProbe.status === "attention_required") {
      return { ok: false, code: "attention_required", message: finalProbe.detail, evidence: finalContent.split("\n").slice(-12).join("\n") };
    }
    if (finalProbe.status === "resumed") {
      return { ok: true };
    }

    // The exact --resume identity is stronger evidence than a pane command or
    // a version/footer heuristic. Use it only with Claude's interactive prompt
    // visible, and after the untrusted screen classifiers have had their say.
    const mayBeWrappedComposer = finalProbe.status === "inconclusive"
      || (finalProbe.status === "failed" && finalProbe.code === "returned_to_shell");
    if (/(^|\n)\s*❯/.test(finalContent) && mayBeWrappedComposer) {
      const identity = await verifyClaudePaneProcess({
        target: tmuxSessionName,
        tmux: this.tmux,
        ...(this.options.listProcesses ? { listProcesses: this.options.listProcesses } : {}),
        expectedToken: resumeToken,
      });
      if (identity) {
        const verifiedProbe = assessNativeResumeProbe({
          runtime: "claude-code",
          paneCommand: finalCommand,
          paneContent: finalContent,
          claudeResumeIdentityVerified: true,
        });
        if (verifiedProbe.status === "resumed") return { ok: true };
      }
    }

    if (finalProbe.code === "returned_to_shell") {
      return {
        ok: false,
        code: "retry_fresh",
        message: "Claude resume failed: pane returned to shell instead of entering Claude",
      };
    }

    return {
      ok: false,
      code: "attention_required",
      message: `Claude resume could not be verified; launch retained: ${finalProbe.detail}`,
      evidence: finalContent.split("\n").slice(-12).join("\n"),
    };
  }
}
