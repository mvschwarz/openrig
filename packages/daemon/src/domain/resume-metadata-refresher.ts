import os from "node:os";
import { execFileSync } from "node:child_process";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import {
  defaultResolveHomeDirByPid,
  readCodexThreadIdFromCandidateHomes,
  type ResolveHomeDirByPid,
} from "./codex-thread-id.js";

export interface ResumeRefreshSession {
  sessionId: string;
  sessionName: string;
  runtime: string | null;
  resumeType: string | null;
  resumeToken: string | null;
}

interface ResumeMetadataRefresherDeps {
  sessionRegistry: SessionRegistry;
  tmuxAdapter: TmuxAdapter;
  listProcesses?: () => Array<{ pid: number; ppid: number; command: string }>;
  readCodexThreadIdByPid?: (pid: number) => string | undefined;
  resolveHomeDirByPid?: ResolveHomeDirByPid;
  sleep?: (ms: number) => Promise<void>;
  homeDir?: string;
}

export class ResumeMetadataRefresher {
  private sessionRegistry: SessionRegistry;
  private tmuxAdapter: TmuxAdapter;
  private listProcesses: () => Array<{ pid: number; ppid: number; command: string }>;
  private readCodexThreadIdByPid: (pid: number) => string | undefined;
  private resolveHomeDirByPid: ResolveHomeDirByPid;
  private sleep: (ms: number) => Promise<void>;
  private homeDir: string;

  constructor(deps: ResumeMetadataRefresherDeps) {
    this.sessionRegistry = deps.sessionRegistry;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.listProcesses = deps.listProcesses ?? defaultListProcesses;
    this.resolveHomeDirByPid = deps.resolveHomeDirByPid ?? defaultResolveHomeDirByPid;
    this.readCodexThreadIdByPid = deps.readCodexThreadIdByPid ?? ((pid) => readCodexThreadIdFromLogs(
      pid,
      this.resolveHomeDirByPid,
      deps.homeDir ?? os.homedir()
    ));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.homeDir = deps.homeDir ?? os.homedir();
  }

  async refresh(sessions: ResumeRefreshSession[]): Promise<void> {
    for (const session of sessions) {
      if (session.runtime !== "codex") continue;
      if (session.resumeToken) continue;

      const threadId = await this.captureCodexThreadId(session.sessionName);
      if (threadId) {
        this.sessionRegistry.updateResumeToken(session.sessionId, "codex_id", threadId);
      }
    }
  }

  private async captureCodexThreadId(sessionTarget: string): Promise<string | undefined> {
    if (!this.tmuxAdapter.getPanePid) return undefined;

    for (let attempt = 0; attempt < 8; attempt++) {
      const shellPid = await this.tmuxAdapter.getPanePid(sessionTarget);
      if (shellPid) {
        const codexPid = findCodexChildPid(this.listProcesses(), shellPid);
        if (codexPid) {
          const threadId = this.readCodexThreadIdByPid(codexPid);
          if (threadId) return threadId;
        }
      }
      await this.sleep(250);
    }

    return undefined;
  }
}

function defaultListProcesses(): Array<{ pid: number; ppid: number; command: string }> {
  try {
    const output = execFileSync("ps", ["-Ao", "pid,ppid,command"], { encoding: "utf-8" });
    return output
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          command: match[3] ?? "",
        };
      })
      .filter((row): row is { pid: number; ppid: number; command: string } => row !== null);
  } catch {
    return [];
  }
}

function findCodexChildPid(processes: Array<{ pid: number; ppid: number; command: string }>, parentPid: number): number | undefined {
  const child = processes.find((proc) => proc.ppid === parentPid && commandLooksLikeCodex(proc.command));
  return child?.pid;
}

function readCodexThreadIdFromLogs(
  pid: number,
  resolveHomeDirByPid: ResolveHomeDirByPid,
  homeDir: string
): string | undefined {
  return readCodexThreadIdFromCandidateHomes(pid, [resolveHomeDirByPid(pid), homeDir, os.homedir()]);
}

function commandLooksLikeCodex(command: string): boolean {
  const trimmed = command.trim();
  return trimmed === "codex" || trimmed.startsWith("codex ");
}
