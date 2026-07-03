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
  // OPR.0.4.3.20 FR-4 — the Claude status-line sidecar reader, for null-fill of a
  // Claude session's resume token from live state during snapshot refresh.
  // Optional + structurally typed (older wirings/tests omit it → Claude null-fill
  // is a silent no-op, Codex behavior unchanged).
  contextUsageStore?: {
    readSidecar(sessionName: string): { ok: true; data: { session_id?: string } } | { ok: false; reason: string };
  };
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
  private contextUsageStore: ResumeMetadataRefresherDeps["contextUsageStore"] | null;

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
    this.contextUsageStore = deps.contextUsageStore ?? null;
  }

  /**
   * Refresh the live per-seat resume ledger.
   *
   * OPR.0.4.3.20 FR-4 (rev1 fix) — `opts.fillNullOnly` is the **snapshot-refresh**
   * mode used by the RECURRING snapshot paths (periodic scheduler every ~5min +
   * manual route). It does exactly two things, both LIGHTWEIGHT (file reads only,
   * like FR-3's capture — Claude sidecar `readSidecar` + Codex `captureCodexThreadId`
   * over pid-logs), and NOTHING heavy:
   *   1. FILL-NULL ONLY — populate a null token from live state; NEVER clear an
   *      already-present token (rev1-r2). A present-but-not-currently-resumable
   *      Claude token SURVIVES the routine snapshot (stays in the ledger for FR-6 to
   *      surface as `stale/unverified — re-verify`) instead of being nulled before
   *      FR-6 exists. Invariant: **a snapshot refresh never clears a present token.**
   *   2. NO heavyweight resumability PROBE — it never runs `probeClaudeResume`
   *      (which spawns a real `claude --resume` tmux session per present Claude seat).
   *      Spawning N probe processes every periodic tick, forever, against live seats
   *      is unacceptable recurring blast radius (rev1-r1). Resumability VERIFICATION
   *      is FR-6's on-demand job, not a recurring-snapshot op.
   *
   * Default (`fillNullOnly` falsy) preserves the legacy validate-and-probe-and-clear
   * behavior for the non-snapshot / teardown auto-pre-down path (a one-time
   * at-shutdown check — unchanged here; FR-6 §2.1b owns unifying the clear semantics
   * across all callers).
   */
  async refresh(sessions: ResumeRefreshSession[], opts?: { fillNullOnly?: boolean }): Promise<void> {
    const fillNullOnly = opts?.fillNullOnly === true;
    for (const session of sessions) {
      if (session.runtime === "codex") {
        if (session.resumeToken) {
          // OPR.0.4.3.20 FR-6.1 — lightweight equal-value freshness RE-STAMP on the
          // periodic (fill-null) path so a present-and-still-valid token does not age
          // to a FALSE `stale — re-verify` after the FR-6 threshold. Re-derive via the
          // SAME pure-read helper FR-3 uses (getPanePid → pid-keyed logs; NO probe/spawn,
          // NO `claude --resume`, NO launch) and refresh freshness ONLY on an EXACT match.
          if (fillNullOnly) {
            const derived = await this.captureCodexThreadId(session.sessionName);
            if (derived && derived === session.resumeToken) {
              // Present + matching = genuine positive evidence; stamp freshness via the
              // FR-6 marker (never updateResumeToken → no token/provenance clobber).
              this.sessionRegistry.markResumeProbeResult(session.sessionId, "resumable");
            }
            // DIFFERENT / ABSENT (rolled or underivable) → no-op: no re-stamp, no clobber.
            // Left honest for FR-6 (stale — re-verify) + FR-7 restore-time rollback.
          }
          continue;
        }

        const threadId = await this.captureCodexThreadId(session.sessionName);
        if (threadId) {
          this.sessionRegistry.updateResumeToken(session.sessionId, "codex_id", threadId, "scrape");
        }
        continue;
      }

      if (session.runtime === "claude-code") {
        if (!session.resumeToken) {
          // OPR.0.4.3.20 FR-4 — null-fill from the Claude status-line sidecar
          // (best-effort; missing/parse-error/empty leaves null, never throws).
          // `scrape` provenance (rank 0) fills a null slot and never clobbers a
          // higher-trust adoption/hook/operator token (the FR-3 rank guard).
          const sidecar = this.contextUsageStore?.readSidecar(session.sessionName);
          if (sidecar?.ok) {
            const token = sidecar.data.session_id;
            if (typeof token === "string" && token.trim().length > 0) {
              this.sessionRegistry.updateResumeToken(session.sessionId, "claude_id", token.trim(), "scrape");
            }
          }
          continue;
        }
        // Present token.
        // OPR.0.4.3.20 FR-4 (rev1 fix) — in snapshot-refresh (fill-null-only) mode,
        // return BEFORE the probe: never spawn the heavyweight `claude --resume`
        // probe on the recurring snapshot path (rev1-r1), and never clear a present
        // token (rev1-r2). A present-but-not-resumable token stays in the ledger for
        // FR-6 to surface as `stale/unverified — re-verify`. Only the legacy/teardown
        // default path probes + clears (a one-time at-shutdown check).
        if (fillNullOnly) {
          // OPR.0.4.3.20 FR-6.1 — equal-value freshness RE-STAMP on the periodic path
          // (NO probe; never spawns `claude --resume`). Re-derive via the pure-read
          // status-line sidecar and refresh freshness ONLY on an EXACT match to the
          // stored token. Different / absent / parse-error / unreadable → no-op: no
          // re-stamp and no token clobber (left honest for FR-6 + FR-7).
          const sidecar = this.contextUsageStore?.readSidecar(session.sessionName);
          if (sidecar?.ok) {
            const derived = sidecar.data.session_id;
            if (typeof derived === "string" && derived.trim().length > 0 && derived.trim() === session.resumeToken) {
              this.sessionRegistry.markResumeProbeResult(session.sessionId, "resumable");
            }
          }
          continue;
        }
        const probe = await this.probeClaudeResume(session.sessionName, session.resumeToken, session.cwd ?? null);
        // OPR.0.4.3.20 FR-6 §2.1b — record the probe result WITHOUT clearing:
        // `not_resumable`/`inconclusive` marks the present token stale (the plan
        // surfaces it as `stale — re-verify`), `resumable` stamps freshness. The
        // token stays put — a rolled-but-present token is no longer silently
        // nulled; FR-7's rollback catches an actually-unresumable token at restore.
        this.sessionRegistry.markResumeProbeResult(session.sessionId, probe);
      }
    }
  }

  /** Best-effort derive a Codex thread id from live pane state (getPanePid →
   *  codex descendant pids → pid-keyed logs sqlite). Async, returns undefined
   *  on timeout/absence. Public for reuse by adoption-boundary capture
   *  (OPR.0.4.3.20 FR-3) — no behavior change to the teardown-path scrape. */
  async captureCodexThreadId(sessionTarget: string): Promise<string | undefined> {
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
