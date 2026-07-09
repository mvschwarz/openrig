// OPR.0.4.6.PI1 FR-6 — Pi seat resume (mirrors codex-resume.ts).
//
// Resume is HONEST session-file continuation: relaunch the pi-runner with
// `--session <persisted sessionFile>` (exact file resume — NEVER `--resume`,
// which opens an interactive picker and is forbidden in managed paths). The
// seat never claims warm-process resume (BR-6 / architecture rule 15
// posture). A missing session file returns `retry_fresh`, which the restore
// orchestrator maps to the awaiting-decision stop-and-ask — never a silent
// fresh start.

import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type { ResumeResult } from "./claude-resume.js";
import {
  piSeatPaths, parsePiRunnerState, buildPiRunnerCommand, buildPendingRunnerState,
} from "./pi-runner-protocol.js";

export { type ResumeResult };

export interface PiResumeFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
}

interface PiResumeOptions {
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  trustPosture?: "approve" | "no-approve";
  /** Launch-attempt id minting (tests inject; defaults to randomUUID). */
  newLaunchId?: () => string;
}

export class PiResumeAdapter {
  constructor(
    private tmux: TmuxAdapter,
    private fs: PiResumeFsOps,
    private paths: { stateRoot: string; runnerEntryPath: string },
    private options: PiResumeOptions = {},
  ) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return resumeType === "pi_session_file" && !!resumeToken;
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    model?: string | null,
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "Pi resume not available" };
    }
    const sessionFile = resumeToken!;

    if (!this.fs.exists(sessionFile)) {
      // The honest zero-session outcome: the caller's retry_fresh mapping
      // realizes the awaiting-decision stop-and-ask (BR-6).
      return { ok: false, code: "retry_fresh", message: "Pi resume failed: the persisted session file no longer exists" };
    }

    const seat = piSeatPaths(this.paths.stateRoot, tmuxSessionName);
    this.fs.mkdirp(seat.agentDir);
    this.fs.mkdirp(seat.sessionsDir);

    // Launch-attempt scoping (guard fold): overwrite any stale sidecar from a
    // prior runner instance BEFORE typing the command; verifyResume trusts
    // only states stamped with THIS attempt's launchId. The prior record is
    // read FIRST so the durable catch-up cursor (lastEntryId, FR-5) survives.
    const launchId = (this.options.newLaunchId ?? (() => randomUUID()))();
    const prior = this.fs.exists(seat.runnerStatePath) ? parsePiRunnerState(this.readSafe(seat.runnerStatePath)) : null;
    this.fs.writeFile(
      seat.runnerStatePath,
      JSON.stringify(buildPendingRunnerState(launchId, new Date().toISOString(), prior)),
    );

    const cmd = buildPiRunnerCommand({
      runnerEntryPath: this.paths.runnerEntryPath,
      sessionName: tmuxSessionName,
      stateRoot: this.paths.stateRoot,
      cwd,
      // The model declaration must survive resume: the runner's provider-key
      // allowlist keys off the declared provider (VM leg finding).
      model: model ?? undefined,
      trust: this.options.trustPosture ?? "no-approve",
      sessionFile,
      launchId,
    });

    const textResult = await this.tmux.sendText(tmuxSessionName, cmd);
    if (!textResult.ok) {
      return { ok: false, code: "resume_failed", message: textResult.message };
    }
    const keyResult = await this.tmux.sendKeys(tmuxSessionName, ["Enter"]);
    if (!keyResult.ok) {
      // Partial failure: command text is in the buffer but Enter failed.
      // Best-effort cleanup: send C-c to clear the typed command.
      await this.tmux.sendKeys(tmuxSessionName, ["C-c"]);
      return { ok: false, code: "resume_failed", message: keyResult.message };
    }

    return this.verifyResume(tmuxSessionName, sessionFile, launchId);
  }

  // Poll the runner's launch-scoped sidecar ONLY — never stale pane
  // scrollback (a prior instance's READY/ERROR markers survive in the pane,
  // and a prior resume of the SAME file would even match; guard fold,
  // code-review qitem-20260707011908). Resumed = THIS attempt's sidecar is
  // ready AND names exactly the requested session file.
  private async verifyResume(tmuxSessionName: string, sessionFile: string, launchId: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 250;
    const maxWaitMs = this.options.maxWaitMs ?? 15_000;
    const sleepFn = this.options.sleep ?? sleep;
    const attempts = Math.max(1, Math.floor(maxWaitMs / Math.max(pollMs, 1)) + 1);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const { runnerStatePath } = piSeatPaths(this.paths.stateRoot, tmuxSessionName);
      const state = this.fs.exists(runnerStatePath) ? parsePiRunnerState(this.readSafe(runnerStatePath)) : null;

      if (state?.launchId === launchId) {
        if (state.exited) {
          const paneContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
          return {
            ok: false,
            code: "resume_failed",
            message: `Pi resume failed: the runner exited (code ${state.exited.code ?? "unknown"})`,
            evidence: paneContent.split("\n").slice(-12).join("\n"),
          } as ResumeResult;
        }
        if (state.ready) {
          if (state.sessionFile !== sessionFile) {
            return {
              ok: false,
              code: "resume_failed",
              message: "Pi resume failed: the runner is ready but does not report the requested session file",
            };
          }
          return { ok: true };
        }
      }

      if (attempt < attempts - 1) {
        await sleepFn(pollMs);
      }
    }

    return {
      ok: false,
      code: "resume_failed",
      message: "Pi resume failed: timed out waiting for the runner to prove the requested session",
    };
  }

  private readSafe(path: string): string {
    try {
      return this.fs.readFile(path);
    } catch {
      return "";
    }
  }
}
