import os from "node:os";
import fs from "node:fs";
import nodePath from "node:path";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import {
  CodexThreadIdResolver,
  defaultResolveHomeDirByPid,
  readCodexThreadIdFromCandidateHomes,
  type ResolveHomeDirByPid,
  type CodexCaptureReporter,
} from "./codex-thread-id.js";
import {
  assessNativeResumeProbe,
  buildNativeResumeCommand,
  isProbeShellReady,
} from "./native-resume-probe.js";
import { runAsyncSite } from "./sync-site-wrap.js";
import { isClaudeSidecarFromEarlierProcess, type ResumeTokenCaptureDeps } from "./resume-token-capture.js";
import { observeClaudePaneRuntime, type NativeProcessLister } from "./native-process-lineage.js";
import { validateResumeToken } from "./resume-token-validation.js";
import { readProcessTable } from "./process-table.js";

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
  listProcesses?: () => Array<{ pid: number; ppid: number; command: string }> | Promise<Array<{ pid: number; ppid: number; command: string }>>;
  readCodexThreadIdByPid?: (pid: number, identity?: string, report?: CodexCaptureReporter) => Promise<string | undefined> | string | undefined;
  probeClaudeResume?: (sessionName: string, resumeToken: string, cwd?: string | null) => Promise<"resumable" | "not_resumable" | "inconclusive">;
  resolveHomeDirByPid?: ResolveHomeDirByPid;
  sleep?: (ms: number) => Promise<void>;
  homeDir?: string;
  codexHome?: string;
  log?: (line: string) => void;
  // OPR.0.4.3.20 FR-4 — the Claude status-line sidecar reader, for null-fill of a
  // Claude session's resume token from live state during snapshot refresh.
  // Optional + structurally typed (older wirings/tests omit it → Claude null-fill
  // is a silent no-op, Codex behavior unchanged).
  contextUsageStore?: {
    readSidecar(sessionName: string): { ok: true; data: { session_id?: string; sampled_at?: string } } | { ok: false; reason: string };
  };
  /** #421 — start time of the pane's current Claude process; a sidecar sampled earlier is not used. */
  claudeProcessStartedAt?: ResumeTokenCaptureDeps["claudeProcessStartedAt"];
  /** Provider root used by the daemon's Claude launches; no scan of other homes. */
  claudeConfigDir?: string;
  listClaudeProcesses?: NativeProcessLister;
}

export class ResumeMetadataRefresher {
  private readonly stopped = new AbortController();
  private readonly captures = new Map<string, { sessionId: string; reasons: Set<string> }>();
  private readonly log: (line: string) => void;
  private sessionRegistry: SessionRegistry;
  private tmuxAdapter: TmuxAdapter;
  private listProcesses: () => Array<{ pid: number; ppid: number; command: string }> | Promise<Array<{ pid: number; ppid: number; command: string }>>;
  private readCodexThreadIdByPid: (pid: number, identity?: string, report?: CodexCaptureReporter) => Promise<string | undefined> | string | undefined;
  private probeClaudeResume: (sessionName: string, resumeToken: string, cwd?: string | null) => Promise<"resumable" | "not_resumable" | "inconclusive">;
  private resolveHomeDirByPid: ResolveHomeDirByPid;
  private sleep: (ms: number) => Promise<void>;
  private homeDir: string;
  private contextUsageStore: ResumeMetadataRefresherDeps["contextUsageStore"] | null;
  private claudeProcessStartedAt: ResumeMetadataRefresherDeps["claudeProcessStartedAt"] | null;
  private claudeConfigDir: string;
  private listClaudeProcesses: NativeProcessLister | undefined;

  constructor(deps: ResumeMetadataRefresherDeps) {
    this.sessionRegistry = deps.sessionRegistry;
    this.log = deps.log ?? console.log;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.listProcesses = deps.listProcesses ?? defaultListProcesses;
    this.resolveHomeDirByPid = deps.resolveHomeDirByPid ?? defaultResolveHomeDirByPid;
    // OPR.0.5.3.10 (addendum): the default thread-id read goes default-home-first
    // with bounded PID-home caching — zero `ps eww` for the common case (298
    // resolve_home spans, mean 8.24s, in one live slow-span sample). An injected
    // readCodexThreadIdByPid (tests, adoption paths) is untouched.
    const threadIdResolver = new CodexThreadIdResolver({
      defaultHome: deps.homeDir ?? os.homedir(),
      codexHome: deps.codexHome,
      resolveHomeDirByPid: this.resolveHomeDirByPid,
    });
    // S10 follow-on: identity is REQUIRED on resolve(); an identity-less read routes EXPLICITLY
    // through the named ungated escape hatch — never a silent fallback (r1 owed item 3).
    this.readCodexThreadIdByPid = deps.readCodexThreadIdByPid
      ?? ((pid, identity, report) => identity === undefined ? threadIdResolver.resolveUngatedLegacy(pid, report) : threadIdResolver.resolve(pid, identity, report));
    this.probeClaudeResume = deps.probeClaudeResume ?? ((sessionName, resumeToken, cwd) => this.defaultProbeClaudeResume(sessionName, resumeToken, cwd));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.homeDir = deps.homeDir ?? os.homedir();
    this.contextUsageStore = deps.contextUsageStore ?? null;
    this.claudeProcessStartedAt = deps.claudeProcessStartedAt ?? null;
    this.claudeConfigDir = deps.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? nodePath.join(this.homeDir, ".claude");
    this.listClaudeProcesses = deps.listClaudeProcesses;
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
   * At shutdown (`fillNullOnly` falsy), first read Claude's live PID-keyed session
   * file: /clear changes its sessionId without changing the launch argv, and the
   * old conversation can still be resumable. If unavailable, retain the existing
   * probe behavior. Never clear a token or add a shutdown refusal.
   */
  async refresh(
    sessions: ResumeRefreshSession[],
    opts?: {
      fillNullOnly?: boolean;
      /** OPR.0.5.3.10 mini-req 2 — a CYCLE-SCOPED process lister (one census for
       *  the whole tick, all rigs and seats). Absent → the instance lister. */
      listProcesses?: () => Promise<Array<{ pid: number; ppid: number; command: string }>>;
    },
  ): Promise<void> {
    const fillNullOnly = opts?.fillNullOnly === true;
    // Snapshot-time discovery is SINGLE-ATTEMPT (mini-req 2): the 8-attempt
    // 250ms-sleep loop exists for the adoption boundary racing a booting codex;
    // on a recurring tick it multiplied `ps` spawns per seat, forever.
    const captureOpts = { attempts: fillNullOnly ? 1 : undefined, listProcesses: opts?.listProcesses };
    for (const session of sessions) {
      if (this.stopped.signal.aborted) return;
      if (session.runtime === "codex") {
        const sessionCaptureOpts = { ...captureOpts, sessionId: session.sessionId };
        if (session.resumeToken) {
          // OPR.0.4.3.20 FR-6.1 — lightweight equal-value freshness RE-STAMP on the
          // periodic (fill-null) path so a present-and-still-valid token does not age
          // to a FALSE `stale — re-verify` after the FR-6 threshold. Re-derive via the
          // SAME pure-read helper FR-3 uses (getPanePid → pid-keyed logs; NO probe/spawn,
          // NO `claude --resume`, NO launch) and refresh freshness ONLY on an EXACT match.
          if (fillNullOnly) {
            const derived = await this.captureCodexThreadId(session.sessionName, sessionCaptureOpts);
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

        const threadId = await this.captureCodexThreadId(session.sessionName, sessionCaptureOpts);
        // A fork's pending id: only its own new conversation may fill it, never one an earlier
        // row (its parent or predecessor) holds; that stays honestly pending.
        if (threadId && !this.sessionRegistry.isForkClaimingHeldToken(session.sessionId, "codex_id", threadId)) {
          this.sessionRegistry.updateResumeToken(session.sessionId, "codex_id", threadId, "scrape");
        }
        continue;
      }

      if (session.runtime === "claude-code") {
        if (!fillNullOnly) {
          const current = await this.captureClaudeSessionId(session);
          if (current && this.sessionRegistry.resumeTokenMatches(session.sessionId, "claude_id", current)) {
            this.sessionRegistry.markResumeProbeResult(session.sessionId, "resumable");
            continue;
          }
          if (current && this.sessionRegistry.updateResumeToken(session.sessionId, "claude_id", current, "scrape")) {
            continue;
          }
        }
        if (!session.resumeToken) {
          // OPR.0.4.3.20 FR-4 — null-fill from the Claude status-line sidecar
          // (best-effort; missing/parse-error/empty leaves null, never throws).
          // `scrape` provenance (rank 0) fills a null slot and never clobbers a
          // higher-trust adoption/hook/operator token (the FR-3 rank guard).
          const sidecar = this.contextUsageStore?.readSidecar(session.sessionName);
          if (sidecar?.ok) {
            const token = sidecar.data.session_id;
            if (typeof token === "string" && token.trim().length > 0
              && !(await isClaudeSidecarFromEarlierProcess(sidecar.data.sampled_at, session.sessionName, this.claudeProcessStartedAt))) {
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
        // default path probes and records freshness without clearing the token.
        if (fillNullOnly) {
          // OPR.0.4.3.20 FR-6.1 — equal-value freshness RE-STAMP on the periodic path
          // (NO probe; never spawns `claude --resume`). Re-derive via the pure-read
          // status-line sidecar and refresh freshness ONLY on an EXACT match to the
          // stored token. Different / absent / parse-error / unreadable → no-op: no
          // re-stamp and no token clobber (left honest for FR-6 + FR-7). An equal token in a sample
          // taken before the pane's current Claude process started is not evidence for it (#421).
          const sidecar = this.contextUsageStore?.readSidecar(session.sessionName);
          if (sidecar?.ok) {
            const derived = sidecar.data.session_id;
            if (typeof derived === "string" && derived.trim().length > 0 && derived.trim() === session.resumeToken
              && !(await isClaudeSidecarFromEarlierProcess(sidecar.data.sampled_at, session.sessionName, this.claudeProcessStartedAt))) {
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

  /** Shutdown-only read, bounded to the stable foreground Claude process's own
   * file. A same-name file or launch argument cannot identify the post-/clear
   * conversation. Missing/ambiguous observations retain the legacy fallback. */
  private async captureClaudeSessionId(session: ResumeRefreshSession): Promise<string | undefined> {
    try {
      const input = { target: session.sessionName, tmux: this.tmuxAdapter, listProcesses: this.listClaudeProcesses };
      const first = await observeClaudePaneRuntime(input);
      if (!first) return undefined;
      const started = Date.parse(first.process.startedAt ?? "");
      if (!Number.isFinite(started)) return undefined;
      const configDir = nodePath.resolve(session.cwd ?? process.cwd(), this.claudeConfigDir);
      const file = nodePath.join(configDir, "sessions", `${first.process.pid}.json`);
      const fd = fs.openSync(file, "r");
      let record: { name?: unknown; sessionId?: unknown };
      try {
        const stat = fs.fstatSync(fd);
        // A leftover file for a reused PID is not current-process evidence.
        if (!stat.isFile() || stat.size > 64 * 1024 || stat.mtimeMs < started) return undefined;
        record = JSON.parse(fs.readFileSync(fd, "utf8"));
      } finally { fs.closeSync(fd); }
      if (record?.name !== session.sessionName) return undefined;
      const valid = validateResumeToken("claude-code", record.sessionId);
      if (!valid.ok) return undefined;
      const final = await observeClaudePaneRuntime(input);
      return final?.fingerprint === first.fingerprint ? valid.token : undefined;
    } catch { return undefined; }
  }

  /** Stop in-flight discovery before shutdown closes HTTP or the database. No wait on native probes. */
  stop(): void { this.stopped.abort(); }

  private captureState(sessionTarget: string, sessionId?: string) {
    const id = sessionId ?? this.sessionRegistry.findResumeContextByName?.(sessionTarget)?.sessionId ?? sessionTarget;
    let state = this.captures.get(sessionTarget);
    if (!state || state.sessionId !== id) {
      state = { sessionId: id, reasons: new Set<string>() };
      this.captures.set(sessionTarget, state);
    }
    return state;
  }

  /** Best-effort derive a Codex thread id from live pane state (getPanePid →
   *  codex descendant pids → pid-keyed logs sqlite). Async, returns undefined
   *  on timeout/absence. Public for reuse by adoption-boundary capture
   *  (OPR.0.4.3.20 FR-3) — no behavior change to the teardown-path scrape. */
  async captureCodexThreadId(
    sessionTarget: string,
    opts?: {
      attempts?: number;
      sessionId?: string;
      listProcesses?: () => Promise<Array<{ pid: number; ppid: number; command: string }>>;
    },
  ): Promise<string | undefined> {
    if (this.stopped.signal.aborted) return undefined;
    const state = this.captureState(sessionTarget, opts?.sessionId);
    const report = (reason: string, count?: number) => {
      if (state.reasons.has(reason)) return;
      state.reasons.add(reason);
      // Native tokens and exception text are credential-class; never log either.
      try { this.log(`[resume-capture] ${sessionTarget}: ${reason}${count === undefined ? "" : ` count=${count}`}`); } catch { /* Diagnostic sinks must not affect capture. */ }
    };
    const ctrl = new AbortController();
    const cancel = () => ctrl.abort();
    this.stopped.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 2000); timer.unref();
    let reason = "no_log_row";
    let count: number | undefined;
    const discover = async (): Promise<string | undefined> => {
      if (!this.tmuxAdapter.getPanePid) { reason = "no_pane_pid"; return undefined; }
      const attempts = Math.max(1, opts?.attempts ?? 8);
      for (let attempt = 0; attempt < attempts && !ctrl.signal.aborted; attempt++) {
        const shellPid = await this.tmuxAdapter.getPanePid(sessionTarget);
        if (ctrl.signal.aborted) return undefined;
        reason = "no_pane_pid"; count = undefined;
        if (shellPid) {
          const rows = await (opts?.listProcesses ?? this.listProcesses)();
          if (ctrl.signal.aborted) return undefined;
          const codexPids = findCodexDescendantPids(rows, shellPid);
          reason = "no_codex_descendant";
          for (const codexPid of codexPids) {
            const identity = (rows.find((r) => r.pid === codexPid) as { startedAt?: string } | undefined)?.startedAt;
            reason = "no_log_row"; count = undefined;
            const threadId = await this.readCodexThreadIdByPid(codexPid, identity, diagnostic => {
              reason = diagnostic.reason; count = diagnostic.count;
            });
            if (ctrl.signal.aborted) return undefined;
            if (threadId) return threadId;
          }
        }
        report(reason, count);
        if (attempt < attempts - 1) await this.sleep(250);
      }
      return undefined;
    };
    let onAbort!: () => void;
    const cancelled = new Promise<undefined>(resolve => {
      onAbort = () => resolve(undefined);
      ctrl.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const token = await Promise.race([discover(), cancelled]);
      if (this.stopped.signal.aborted) { report("shutdown"); return undefined; }
      if (token) { report("captured"); return token; }
      report(ctrl.signal.aborted ? "probe_timeout" : reason, ctrl.signal.aborted ? undefined : count);
      return undefined;
    } catch (error) {
      if (this.stopped.signal.aborted) return undefined;
      // Report the redacted reason once, then let the failure reach the caller as it always did
      // (teardown records "Resume metadata refresh failed"; adoption swallows it).
      report("process_unreadable");
      throw error;
    } finally {
      clearTimeout(timer);
      ctrl.signal.removeEventListener("abort", onAbort);
      this.stopped.signal.removeEventListener("abort", cancel);
    }
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
    const create = this.tmuxAdapter.deliveryGuard
      ? await this.tmuxAdapter.createProbeSession(probeSession, resolveProbeCwd(cwd, this.homeDir))
      : await this.tmuxAdapter.createSession(probeSession, resolveProbeCwd(cwd, this.homeDir));
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

// Exported for unit test (B12-T): the REAL async sampling path — the anti-vacuity test drives
// this default directly (every other suite injects sync stubs) and asserts the non-blocking
// property that the pre-B12 sync implementation violated.
export async function defaultListProcesses(): Promise<Array<{ pid: number; ppid: number; command: string }>> {
  try {
    return await defaultListProcessesStrict();
  } catch {
    return [];
  }
}

/** OPR.0.5.3.10 r2-B2 — the STRICT production lister: a failed `ps` spawn
 *  REJECTS instead of degrading to []. This is the census's default —
 *  through the lenient variant above, an enumeration failure became a CACHED
 *  empty SUCCESS for the whole freshness window (r2's discriminator: 0 rows
 *  cached while 520 were live). The lenient variant keeps its contract for
 *  the direct per-call consumers that want best-effort. */
export async function defaultListProcessesStrict(): Promise<Array<{ pid: number; ppid: number; command: string; startedAt: string }>> {
  // startedAt = the process START TIME — the identity half of pid+start-time
  // (r1's pid-reuse remedy): a reused pid changes it, so a consumer
  // holding last cycle's identity can invalidate without any extra spawn.
  const rows = await runAsyncSite("resume_metadata.list_processes", readProcessTable);
  return rows.map(({ pid, ppid, startedAt, command }) => ({ pid, ppid, startedAt, command }));
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
  resolvedHome: string | undefined,
  homeDir: string
): string | undefined {
  return readCodexThreadIdFromCandidateHomes(pid, [resolvedHome, homeDir, os.homedir()]);
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
