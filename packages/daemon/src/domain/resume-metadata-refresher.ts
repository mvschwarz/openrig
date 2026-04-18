import os from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import {
  defaultResolveHomeDirByPid,
  readCodexThreadIdFromCandidateHomes,
  type ResolveHomeDirByPid,
} from "./codex-thread-id.js";
import {
  assessNativeResumeProbe,
  buildNativeResumeCommand,
  isProbeShellReady,
} from "./native-resume-probe.js";

export interface ResumeRefreshSession {
  sessionId: string;
  sessionName: string;
  runtime: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  cwd?: string | null;
}

interface ResumeMetadataRefresherDeps {
  sessionRegistry: SessionRegistry;
  tmuxAdapter: TmuxAdapter;
  listProcesses?: () => Array<{ pid: number; ppid: number; command: string }>;
  readCodexThreadIdByPid?: (pid: number) => string | undefined;
  probeClaudeResume?: (sessionName: string, resumeToken: string, cwd?: string | null) => Promise<"resumable" | "not_resumable" | "inconclusive">;
  resolveHomeDirByPid?: ResolveHomeDirByPid;
  sleep?: (ms: number) => Promise<void>;
  homeDir?: string;
}

export class ResumeMetadataRefresher {
  private sessionRegistry: SessionRegistry;
  private tmuxAdapter: TmuxAdapter;
  private listProcesses: () => Array<{ pid: number; ppid: number; command: string }>;
  private readCodexThreadIdByPid: (pid: number) => string | undefined;
  private probeClaudeResume: (sessionName: string, resumeToken: string, cwd?: string | null) => Promise<"resumable" | "not_resumable" | "inconclusive">;
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
    this.probeClaudeResume = deps.probeClaudeResume ?? ((sessionName, resumeToken, cwd) => this.defaultProbeClaudeResume(sessionName, resumeToken, cwd));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.homeDir = deps.homeDir ?? os.homedir();
  }

  async refresh(sessions: ResumeRefreshSession[]): Promise<void> {
    for (const session of sessions) {
      if (session.runtime === "codex") {
        if (session.resumeToken) continue;

        const threadId = await this.captureCodexThreadId(session.sessionName);
        if (threadId) {
          this.sessionRegistry.updateResumeToken(session.sessionId, "codex_id", threadId);
        }
        continue;
      }

      if (session.runtime === "claude-code" && session.resumeToken) {
        const probe = await this.probeClaudeResume(session.sessionName, session.resumeToken, session.cwd ?? null);
        if (probe === "not_resumable") {
          this.sessionRegistry.clearResumeToken(session.sessionId);
        }
      }
    }
  }

  private async captureCodexThreadId(sessionTarget: string): Promise<string | undefined> {
    if (!this.tmuxAdapter.getPanePid) return undefined;

    for (let attempt = 0; attempt < 8; attempt++) {
      const shellPid = await this.tmuxAdapter.getPanePid(sessionTarget);
      if (shellPid) {
        const codexPids = findCodexDescendantPids(this.listProcesses(), shellPid);
        for (const codexPid of codexPids) {
          const threadId = this.readCodexThreadIdByPid(codexPid);
          if (threadId) return threadId;
        }
      }
      await this.sleep(250);
    }

    return undefined;
  }

  private async defaultProbeClaudeResume(
    sessionName: string,
    resumeToken: string,
    cwd?: string | null,
  ): Promise<"resumable" | "not_resumable" | "inconclusive"> {
    const command = buildNativeResumeCommand("claude-code", resumeToken, sessionName);
    if (!command) {
      return "not_resumable";
    }

    const probeSession = `rigged-refresh-${sanitizeTmuxName(sessionName)}-${Date.now().toString(36)}`;
    const create = await this.tmuxAdapter.createSession(probeSession, resolveProbeCwd(cwd, this.homeDir));
    if (!create.ok) {
      return "inconclusive";
    }

    try {
      const shellReady = await this.waitForProbeShellReady(probeSession);
      if (!shellReady) {
        return "inconclusive";
      }

      const send = await this.tmuxAdapter.sendText(probeSession, command);
      if (!send.ok) {
        return "inconclusive";
      }
      const enter = await this.tmuxAdapter.sendKeys(probeSession, ["Enter"]);
      if (!enter.ok) {
        return "inconclusive";
      }

      const attempts = 24;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const paneCommand = await this.tmuxAdapter.getPaneCommand(probeSession);
        const paneContent = (await this.tmuxAdapter.capturePaneContent(probeSession, 80)) ?? "";
        const result = assessNativeResumeProbe({
          runtime: "claude-code",
          paneCommand,
          paneContent,
        });

        if (result.status === "resumed") {
          return "resumable";
        }
        if (result.status === "failed") {
          return "not_resumable";
        }

        if (attempt < attempts - 1) {
          await this.sleep(250);
        }
      }

      return "inconclusive";
    } finally {
      await this.tmuxAdapter.killSession(probeSession);
    }
  }

  private async waitForProbeShellReady(sessionName: string): Promise<boolean> {
    const attempts = 16;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmuxAdapter.getPaneCommand(sessionName);
      const paneContent = (await this.tmuxAdapter.capturePaneContent(sessionName, 20)) ?? "";
      if (isProbeShellReady({ paneCommand, paneContent })) {
        return true;
      }
      if (attempt < attempts - 1) {
        await this.sleep(250);
      }
    }

    return false;
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

function findCodexDescendantPids(
  processes: Array<{ pid: number; ppid: number; command: string }>,
  parentPid: number
): number[] {
  const childrenByParent = new Map<number, Array<{ pid: number; command: string }>>();
  for (const proc of processes) {
    const siblings = childrenByParent.get(proc.ppid) ?? [];
    siblings.push({ pid: proc.pid, command: proc.command });
    childrenByParent.set(proc.ppid, siblings);
  }

  const matches: number[] = [];
  const visit = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      visit(child.pid);
      if (commandLooksLikeCodex(child.command)) {
        matches.push(child.pid);
      }
    }
  };

  visit(parentPid);
  return matches;
}

function readCodexThreadIdFromLogs(
  pid: number,
  resolveHomeDirByPid: ResolveHomeDirByPid,
  homeDir: string
): string | undefined {
  return readCodexThreadIdFromCandidateHomes(pid, [resolveHomeDirByPid(pid), homeDir, os.homedir()]);
}

function commandLooksLikeCodex(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  return tokens.some((token) => {
    const unquoted = token.replace(/^['"]|['"]$/g, "");
    const base = nodePath.basename(unquoted);
    return base === "codex";
  });
}

function sanitizeTmuxName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveProbeCwd(cwd: string | null | undefined, homeDir: string): string {
  if (!cwd || cwd === ".") {
    return process.cwd();
  }
  return cwd;
}
