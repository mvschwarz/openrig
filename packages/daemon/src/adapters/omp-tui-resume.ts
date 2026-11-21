// OMP seat resume for legacy (non-pod-aware) restore, mirroring codex-resume.ts.

import type { ResumeResult } from "./claude-resume.js";
import type { OmpSeatLauncher } from "./omp-seat-launch.js";

export { type ResumeResult };

export class OmpTuiResumeAdapter {
  constructor(
    private readonly launcher: OmpSeatLauncher,
    private readonly sessionFileExists: (path: string) => boolean,
  ) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return resumeType === "omp_tui_session_file" && !!resumeToken;
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    model?: string | null,
    resolvedPosture?: "floor" | "full_bypass" | "auto",
    effort?: string | null,
    launchWrapper?: readonly string[],
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "OMP resume not available" };
    }
    const sessionFile = resumeToken!;
    if (!this.sessionFileExists(sessionFile)) {
      return { ok: false, code: "retry_fresh", message: "OMP resume failed: the persisted session file no longer exists" };
    }

    const outcome = await this.launcher.launch({
      sessionName: tmuxSessionName,
      cwd,
      model,
      effort,
      launchPosture: resolvedPosture,
      launchWrapper,
      sessionFile,
    });
    if (!outcome.ok) {
      if (outcome.reason === "session_not_found") {
        return { ok: false, code: "retry_fresh", message: `OMP resume failed: ${outcome.message}` };
      }
      return {
        ok: false,
        code: outcome.reason === "timeout" ? "attention_required" : "resume_failed",
        message: outcome.reason === "send_failed" ? outcome.message : `OMP resume failed: ${outcome.message}`,
        ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
      };
    }
    // Resumed means this attempt's OMP is ready and names exactly the requested session file.
    if (outcome.state.sessionFile !== sessionFile) {
      return { ok: false, code: "attention_required", message: "OMP resume failed: OMP is ready but does not report the requested session file" };
    }
    return { ok: true, appliedLaunch: outcome.appliedLaunch, ...(outcome.warnings ? { warnings: outcome.warnings } : {}) };
  }
}
