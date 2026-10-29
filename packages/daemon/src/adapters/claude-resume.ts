import type { ClaudePermissionRules } from "../domain/claude-permission-rules.js";
import { withManagedRestoreReads, type RestoreReadPolicy } from "../domain/managed-restore-read-access.js";
import { operationalLaunchArgs } from "./kernel-authority.js";
import { claudeMcpArgs, type ClaudeMcp } from "../domain/claude-mcp.js";
import { claudeSeatTokenFallbackNotice } from "../domain/claude-seat-token.js";
import { setTimeout as sleep } from "node:timers/promises";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import { shellQuote } from "./shell-quote.js";
import { claudeResumeLaunchEnv, claudeResumeLaunchPrefix } from "./claude-resume-launch.js";
import { claudePostureFlag, claudeClassicRendererEnvPrefix } from "./yolo-mode.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { verifyClaudePaneProcess, verifyPaneIdleShell, type ClaudeLaunchedProcess, type NativeProcessLister } from "../domain/native-process-lineage.js";
import { observeClaudePermission, type AppliedLaunchObservation } from "../domain/permission-drift.js";
import { unresolvedClaudePermissionModes } from "../domain/native-permission-selection.js";
import type { ClaudeManagedLaunch } from "../domain/claude-managed-launch.js";
import { seatLaunchAdditionArgs, type SeatLaunchAdditions } from "../domain/seat-launch-additions.js";

export type ResumeResult =
  // `launchedProcess` (Claude): the process this resume's own identity check observed (#1077).
  | { ok: true; appliedLaunch?: AppliedLaunchObservation; launchedProcess?: ClaudeLaunchedProcess;
    /** Launch notes for the person, such as a seat token that wasn't applied. */
    warnings?: string[] }
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
  openrigHome?: string;
  /** The compaction settings the restore reads from, so the launch grants those files too. */
  restoreReadPolicy?: () => RestoreReadPolicy | null;
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
    nonInterruptive?: boolean,
    kernelAuthority?: boolean,
    teamPermissionDefault?: boolean,
    advisor?: string | null,
    // OPR.0.7.0.9: the seat's own launch additions (copies in its seat storage); absent → byte-identical.
    launchAdditions?: SeatLaunchAdditions,
    claudePermissions?: ClaudePermissionRules,
    beforeNativeDispatch?: () => boolean,
    executable?: string,
    claudeMcp?: ClaudeMcp,
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "Claude resume not available" };
    }

    // OPR.0.4.8.2: the RESTORE path uses the SAME launch-posture decision as fresh launch (the
    // unconditional acceptEdits floor when OFF; the full bypass when YOLO is ON) — every seat.
    // 0.5.2-07: --model matches the fresh-launch adapter (claude-code-adapter), emitted after posture.
    const modelArg = model ? ` --model ${shellQuote(model)}` : "";
    const effortArg = effort ? ` --effort ${shellQuote(effort)}` : "";
    advisor = advisor?.trim();
    const advisorArg = advisor ? ` --advisor ${shellQuote(advisor)}` : "";
    const mcpArgs = claudeMcpArgs(claudeMcp);
    const mcpArg = mcpArgs.map(arg => ` ${shellQuote(arg)}`).join("");
    const additionArgs = seatLaunchAdditionArgs(launchAdditions);
    const additionArg = additionArgs.map((arg, index) => ` ${index % 2 === 0 ? arg : shellQuote(arg)}`).join(""); // flag, value pairs
    let managed: Awaited<ReturnType<ClaudeManagedLaunch["prepare"]>> | undefined;
    if (selectedPermissionMode !== undefined) {
      try {
        if (!nodeId || !this.options.claudeManagedLaunch) await unresolvedClaudePermissionModes();
        managed = await this.options.claudeManagedLaunch!.prepare({ nodeId: nodeId!, cwd, session: tmuxSessionName,
          ...(executable ? { executable } : {}) }, selectedPermissionMode);
      } catch (error) { return { ok: false, code: "permission_selection_refused", message: (error as Error).message }; }
    }
    // A seat's own subscription token, as on a fresh launch (claude-code-adapter.ts).
    let seatToken: ReturnType<ClaudeManagedLaunch["seatTokenLaunch"]> = null;
    if (!managed && nodeId) {
      try { seatToken = this.options.claudeManagedLaunch?.seatTokenLaunch?.(nodeId) ?? null; }
      catch (error) { return { ok: false, code: "api_key_unavailable", message: (error as Error).message }; }
    }
    const requiresApiKey = seatToken?.ref.kind === "api-key";
    const tokenWarnings: string[] = [...(managed?.warnings ?? seatToken?.warnings ?? [])];
    if (seatToken) tokenWarnings.push(...(await this.options.claudeManagedLaunch?.tokenPrecedenceWarnings?.(nodeId!, seatToken.ref) ?? []));
    const choice = { claudePermissions, kernelAuthority, teamPermissionDefault, nonInterruptive, launchPosture: resolvedPosture, permissionMode: selectedPermissionMode };
    const posture = claudePostureFlag(process.env, resolvedPosture, selectedPermissionMode);
    const appliedLaunch = observeClaudePermission(posture);
    const launchArgs = withManagedRestoreReads(operationalLaunchArgs("claude-code", choice), {
      openrigHome: this.options.openrigHome, session: tmuxSessionName, cwd, nativeSessionId: resumeToken!,
      ...(this.options.restoreReadPolicy?.() ?? {}),
    });
    const permissionMode = posture + launchArgs.map(arg => ` ${shellQuote(arg)}`).join("");
    const cmd = managed ? managed.command(["--permission-mode", selectedPermissionMode!, ...launchArgs, ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), ...(advisor ? ["--advisor", advisor] : []), ...mcpArgs, ...additionArgs, "--resume", resumeToken!], claudeResumeLaunchEnv(resumeToken!))
      : `${claudeResumeLaunchPrefix(resumeToken!)}${claudeClassicRendererEnvPrefix(process.env)}${executable ? `exec ${shellQuote(executable)}` : "claude"} ${permissionMode}${modelArg}${effortArg}${advisorArg}${mcpArg}${additionArg} --resume ${shellQuote(resumeToken!)}`;

    const assertSelected = beforeNativeDispatch ? () => { if (!beforeNativeDispatch()) throw new Error("Selected history changed before Claude resume input"); } : undefined;
    const beforeManagedInput = beforeNativeDispatch ? () => { assertSelected?.(); managed?.assertCurrent?.(); } : managed?.assertCurrent;

    const sendClassic = async () => {
      if (!this.options.seatLaunchEnvironment) {
        if (requiresApiKey) return { ok: false as const, code: "api_key_unavailable", message: "This launch cannot apply the selected API key; no Claude process started." };
        if (seatToken) tokenWarnings.push(this.options.claudeManagedLaunch?.tokenNotApplied?.(nodeId!, seatToken.ref, "this launch path can't run the token step") ?? claudeSeatTokenFallbackNotice(seatToken.ref, "this launch path can't run the token step"));
        if (beforeNativeDispatch && !beforeNativeDispatch()) return { ok: false as const, code: "selection_changed", message: "Selected history changed before Claude resume input" };
        return assertSelected ? this.tmux.sendText(tmuxSessionName, cmd, assertSelected) : this.tmux.sendText(tmuxSessionName, cmd);
      }
      const staged = await this.options.seatLaunchEnvironment.command(tmuxSessionName, cmd, { runtime: "claude-code", nodeId,
        ...(seatToken ? { claudeTokenStep: seatToken.step } : {}) });
      if (seatToken && !staged.includes(seatToken.step)) {
        if (requiresApiKey) return { ok: false as const, code: "api_key_unavailable", message: "This pane cannot apply the selected API key; no Claude process started." };
        tokenWarnings.push(this.options.claudeManagedLaunch?.tokenNotApplied?.(nodeId!, seatToken.ref, "the seat's pane shell can't run the token step") ?? claudeSeatTokenFallbackNotice(seatToken.ref, "the seat's pane shell can't run the token step"));
      }
      if (beforeNativeDispatch && !beforeNativeDispatch()) return { ok: false as const, code: "selection_changed", message: "Selected history changed before Claude resume input" };
      return assertSelected ? this.tmux.sendShellCommand(tmuxSessionName, staged, assertSelected, { sourceInPane: true })
        : this.tmux.sendShellCommand(tmuxSessionName, staged, undefined, { sourceInPane: true });
    };
    if (beforeNativeDispatch && !beforeNativeDispatch()) return { ok: false, code: "attention_required", message: "Selected history changed during Claude resume preparation; no native command was sent." };
    const textResult = managed ? await this.tmux.sendShellCommand(tmuxSessionName, cmd, beforeManagedInput) : await sendClassic();
    if (!textResult.ok) {
      // sendText failed — nothing in the buffer, no cleanup needed
      return { ok: false, code: "resume_failed", message: textResult.message };
    }

    const keyResult = managed || this.options.seatLaunchEnvironment ? { ok: true as const }
      : await (assertSelected ? this.tmux.sendKeys(tmuxSessionName, ["Enter"], assertSelected) : this.tmux.sendKeys(tmuxSessionName, ["Enter"]));
    if (!keyResult.ok) {
      // Partial failure: command text is in the buffer but Enter failed.
      // Best-effort cleanup: send C-c to clear the typed command.
      if (!beforeNativeDispatch || beforeNativeDispatch()) await this.tmux.sendKeys(tmuxSessionName, ["C-c"], assertSelected);
      return { ok: false, code: "resume_failed", message: keyResult.message };
    }

    const result = await this.verifyResume(tmuxSessionName, resumeToken!).catch((error): ResumeResult => ({
      ok: false,
      code: "attention_required",
      message: `Claude resume observation unavailable; launch retained: ${error instanceof Error ? error.message : String(error)}`,
    }));
    return result.ok ? { ...result, appliedLaunch, ...(tokenWarnings.length ? { warnings: tokenWarnings } : {}) } : result;
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
        if (verifiedProbe.status === "resumed") {
          // The process this check proved is the launch's record of what it started; the caller
          // keeps it rather than reading the pane again.
          return { ok: true, ...(identity.process.startedAt
            ? { launchedProcess: { pid: identity.process.pid, startedAt: identity.process.startedAt } } : {}) };
        }
      }
    }

    if (finalProbe.code === "returned_to_shell") {
      // A shell label alone isn't a return to the shell: a launch script still starting Claude holds the pane the
      // same way. Only a proven, stable idle shell ends the resume; anything else keeps the launch for attention.
      if (await verifyPaneIdleShell({ target: tmuxSessionName, tmux: this.tmux,
        ...(this.options.listProcesses ? { listProcesses: this.options.listProcesses } : {}) })) {
        return {
          ok: false,
          code: "retry_fresh",
          message: "Claude resume failed: pane returned to shell instead of entering Claude",
        };
      }
      return {
        ok: false,
        code: "attention_required",
        message: "Claude resume could not be verified; launch retained: the pane shows a shell that isn't a proven idle shell, so a launch script may still be starting Claude.",
        evidence: finalContent.split("\n").slice(-12).join("\n"),
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
