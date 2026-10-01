import type { TmuxAdapter } from "./tmux.js";
import type { ResumeResult } from "./claude-resume.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import fs from "node:fs";
import {
  buildCursorLaunchCommand, cursorChatApprovalChanged, cursorSeatConfigDir, resetCursorSeatConfig, recordCursorChatLaunch,
  type CursorAdapterFsOps,
} from "./cursor-runtime-adapter.js";
import { cursorApprovalArg } from "./yolo-mode.js";

interface CursorResumeOptions {
  stateRoot: string;
  launchPath?: string;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Used for the seat's persisted approval mode and OpenRig's chat-launch record; defaults to node:fs. */
  fsOps?: CursorResumeFsOps;
}

type CursorResumeFsOps = Pick<CursorAdapterFsOps, "readFile" | "writeFile" | "exists"> & Partial<Pick<CursorAdapterFsOps, "mkdirp">>;

const nodeFsOps: CursorResumeFsOps = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
  exists: (p) => fs.existsSync(p),
  mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
};

/** Legacy restore for Cursor seats: relaunch the stored chat and wait for Cursor's prompt. */
export class CursorResumeAdapter {
  constructor(private tmux: TmuxAdapter, private options: CursorResumeOptions) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return resumeType === "cursor_chat_id" && !!resumeToken;
  }

  async resume(
    sessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    nodeId: string,
    model?: string | null,
    resolvedPosture?: "floor" | "full_bypass",
    permissionMode?: string,
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) return { ok: false, code: "no_resume", message: "Cursor resume not available" };
    let approvalArg: string;
    try { approvalArg = cursorApprovalArg(process.env, resolvedPosture, permissionMode); } catch (err) {
      return { ok: false, code: "resume_failed", message: (err as Error).message };
    }
    const configDir = cursorSeatConfigDir(this.options.stateRoot, nodeId);
    const fsOps = this.options.fsOps ?? nodeFsOps;
    // Cursor keeps the approval mode per chat and has no flag to lower it, and this path cannot create chats.
    if (cursorChatApprovalChanged(fsOps, configDir, resumeToken!, approvalArg)) {
      return { ok: false, code: "retry_fresh", message: "Cursor permission mode changed since this chat last ran (or OpenRig has no record of its mode); a fresh chat is required for the new mode to apply." };
    }
    try { resetCursorSeatConfig(fsOps, configDir, permissionMode, model); } catch (err) {
      return { ok: false, code: "resume_failed", message: `cursor: could not reset the seat config: ${(err as Error).message}` };
    }
    try { fsOps.mkdirp?.(configDir); recordCursorChatLaunch(fsOps, configDir, resumeToken!, approvalArg); } catch (err) {
      return { ok: false, code: "resume_failed", message: `cursor: could not record the chat launch: ${(err as Error).message}` };
    }
    const command = buildCursorLaunchCommand({
      chatId: resumeToken!, configDir, model, approvalArg, launchPath: this.options.launchPath,
    });
    const sent = await this.tmux.sendShellCommand(sessionName, command);
    if (!sent.ok) return { ok: false, code: "resume_failed", message: `Failed to send resume command: ${sent.message}` };

    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const pollMs = this.options.pollMs ?? 1000;
    const deadline = Date.now() + (this.options.maxWaitMs ?? 30_000);
    let lastScreen = "";
    while (Date.now() <= deadline) {
      lastScreen = (this.tmux.capturePaneScreen
        ? await this.tmux.capturePaneScreen(sessionName)
        : await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
      const probe = assessNativeResumeProbe({ runtime: "cursor", paneCommand: await this.tmux.getPaneCommand(sessionName), paneContent: lastScreen });
      if (probe.status === "resumed") return { ok: true };
      if (probe.status === "attention_required") return { ok: false, code: "attention_required", message: probe.detail, evidence: lastScreen.split("\n").slice(-12).join("\n") };
      await sleep(pollMs);
    }
    return { ok: false, code: "resume_failed", message: `Cursor did not show its prompt within the wait (cwd ${cwd}).` };
  }
}
