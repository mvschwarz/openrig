import { nonInterruptiveArg } from "./non-interruptive.js";
import { setTimeout as sleep } from "node:timers/promises";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import type { ResumeResult } from "./claude-resume.js";
import { assessNativeResumeProbe, buildCodexResumeCore } from "../domain/native-resume-probe.js";
import { runSyncSite } from "../domain/sync-site-wrap.js";
import { shellQuote } from "./shell-quote.js";
import { codexPostureArg } from "./yolo-mode.js";
import { observeCodexSandbox } from "../domain/permission-drift.js";
import { unknownDaemonSupportMessage, type CodexDaemonSupportDetector } from "../domain/codex-daemon-support.js";
import { codexNetworkDefaultArg, type CodexNetworkDefaultReader } from "../domain/codex-network-default.js";

const CODEX_TYPES = new Set(["codex_id", "codex_last"]);
const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export { type ResumeResult };

interface CodexResumeOptions {
  seatLaunchEnvironment?: SeatLaunchEnvironment;
  launchPath?: string;
  codexHome?: string;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  exec?: (cmd: string) => Promise<string>;
  /** #69: whether the installed Codex supports --no-daemon; absent keeps the existing invocation. */
  detectDaemonSupport?: CodexDaemonSupportDetector;
  /** #275: Codex's own answer on the plain floor's network default; absent keeps the existing invocation. */
  readNetworkDefault?: CodexNetworkDefaultReader;
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
    cwd: string,
    codexConfigProfile?: string | null,
    // OPR.0.4.8.3 Seam B: persisted resolved posture threaded from restore.
    resolvedPosture?: "floor" | "full_bypass" | "auto",
    // 0.5.2-07: the seat's SPEC-pinned model. TRAILING param so existing positional callers that pass
    // resolvedPosture as the 6th arg stay correct; threaded so the legacy (non-pod-aware) restore boots
    // the resumed seat on its spec model, not the runtime default; absent → command byte-identical.
    model?: string | null,
    // #75: optional reasoning effort for the seat.
    effort?: string | null,
    nonInterruptive?: boolean,
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "Codex resume not available" };
    }

    if (codexConfigProfile?.trim()) {
      const { verifyCodexProfileLoads } = await import("../domain/codex-profile-preflight.js");
      const execFn = this.options.exec ?? (async (cmd: string) => {
        const { execSync } = await import("node:child_process");
        return runSyncSite("codex.resume.profile_preflight", () =>
          execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000,
            ...(this.options.codexHome ? { cwd, env: { ...process.env, CODEX_HOME: this.options.codexHome, ...(this.options.launchPath ? { PATH: this.options.launchPath } : {}) } } : {}),
          })
        );
      });
      const probeResult = await verifyCodexProfileLoads(codexConfigProfile, execFn, undefined, this.options.codexHome);
      if (!probeResult.ok) {
        return {
          ok: false,
          code: "resume_failed",
          message: `Profile preflight failed: ${probeResult.error}${probeResult.migrationHint ? `\n  Fix: ${probeResult.migrationHint}` : ""}`,
        };
      }
    }

    // #69: detect for the Codex the restored pane runs (its cwd, the launch PATH).
    const daemonSupport = this.options.detectDaemonSupport ? await this.options.detectDaemonSupport(cwd) : undefined;
    if (daemonSupport?.kind === "unknown") {
      return { ok: false, code: "resume_failed", message: unknownDaemonSupportMessage(daemonSupport.detail) };
    }

    const profileArg = codexConfigProfile ? ` -p ${shellQuote(codexConfigProfile)}` : "";
    const posture = codexPostureArg(profileArg, process.env, resolvedPosture);
    const appliedLaunch = observeCodexSandbox(posture);
    const postureArg = posture + nonInterruptiveArg("codex", { nonInterruptive, launchPosture: resolvedPosture });
    const networkArg = await codexNetworkDefaultArg(this.options.readNetworkDefault, appliedLaunch, cwd, tmuxSessionName);
    const cmd = buildCodexResumeCore(
      resumeToken ?? "",
      codexConfigProfile,
      resumeType === "codex_last",
      undefined,
      resolvedPosture,
      model,
      `${postureArg}${networkArg}`,
      daemonSupport?.kind === "supported",
      effort,
    );

    const launchEnv = [this.options.launchPath ? `PATH=${shellQuote(this.options.launchPath)}` : "", this.options.codexHome ? `CODEX_HOME=${shellQuote(this.options.codexHome)}` : ""].filter(Boolean);
    const textResult = await this.tmux.sendShellCommand(tmuxSessionName, this.options.seatLaunchEnvironment
      ? await this.options.seatLaunchEnvironment.command(tmuxSessionName, cmd, { codexCwd: cwd, runtime: "codex" })
      : launchEnv.length ? `env ${launchEnv.join(" ")} ${cmd}` : cmd);
    if (!textResult.ok) {
      return { ok: false, code: "resume_failed", message: textResult.message };
    }

    const result = await this.verifyResume(tmuxSessionName);
    return result.ok ? { ...result, appliedLaunch } : result;
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
