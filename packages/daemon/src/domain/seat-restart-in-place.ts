import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { isStagedSendScriptPath, type TmuxAdapter } from "../adapters/tmux.js";
import type { ArbitratedSeatState } from "./activity-taxonomy.js";
import type { EventBus } from "./event-bus.js";
import type { SessionRegistry } from "./session-registry.js";
import type { HarnessLaunchResult, NodeBinding } from "./runtime-adapter.js";
import type { PersistedEvent, RigEvent } from "./types.js";
import {
  codexCommandResumeToken, listNativeProcesses, processArgv, verifyCodexPaneProcess,
  type NativeProcessLister, type NativeProcessRow,
} from "./native-process-lineage.js";
import { CodexThreadIdResolver, resolveCodexDbPaths, type CodexThreadEvidence } from "./codex-thread-id.js";
import { isShellForeground } from "./shell-classifier.js";
import { terminatePaneInPlace, type PaneCutoverTiming } from "./pane-cutover.js";
import { rebindAndVerifyPaneIdentity } from "./seat-attention-reconciler.js";
import type { RunningCodexLaunch } from "../adapters/codex-runtime-adapter.js";
import { emittedEffortFromArgv } from "./seat-effort.js";
import { CODEX_NETWORK_DEFAULT_OVERRIDE } from "./codex-network-default.js";

/**
 * OPR.0.7.0.5 — restart ONE Codex seat in place so it reads its Codex home's current account: the same
 * conversation, resumed in the same pane, with the settings it is running with now, except reasoning effort,
 * which follows the seat's saved choice like every managed continuation (OPR.0.7.0.7). It never launches fresh,
 * forks, re-delivers startup context or retries; it never switches an account or reads token-bearing files.
 *
 * Reusable primitive: gates, the in-place resume for both pane shapes, and the per-seat report. Callers
 * (SeatLifecycleService) resolve the seat, hold its lifecycle lease and apply the shared refusals first.
 *
 * What it does NOT prove: that Codex saved its rollout before TERM/KILL, or that a stop part-way through
 * leaves history intact. Timing is not evidence of either; both are NOT VERIFIED until measured natively.
 */

export type InPlaceRestartTmux = Pick<TmuxAdapter,
  | "getPanePid" | "getPaneCommand" | "listPanes" | "getSessionEnv" | "signalPid" | "setRemainOnExit"
  | "signalPaneProcess" | "isPaneDead" | "respawnPane" | "getPaneLocalOption" | "restorePaneOption"
  | "capturePaneHistory" | "capturePaneHistoryParts">;

/** The Codex runtime adapter's resume surface this operation reuses. */
export interface InPlaceCodexLauncher {
  buildResumeCommand(binding: NodeBinding, opts: { name: string; resumeToken: string; running?: RunningCodexLaunch }):
    Promise<{ ok: true; command: string; core: string } | { ok: false; error: string }>;
  /** `nodeId` lets the resume proof read the seat's own CODEX_HOME when it declares one; `home`, the one the running
   *  Codex was read using, wins over both that and the daemon's. */
  verifyResumeInPane(tmuxSession: string, resumeToken: string, nodeId?: string, home?: string): Promise<HarnessLaunchResult>;
  /** Types a built command into the pane's shell and verifies the resume, preparing nothing again. */
  sendResumeCommand(tmuxSession: string, command: string, resumeToken: string, nodeId?: string, home?: string): Promise<HarnessLaunchResult>;
}

/** What one process shows about itself, read without touching any credential: cwd, executable, and only
 *  the named environment values below. Other environment values are never kept. */
export interface ProcessFacts {
  cwd: string | null;
  exe: string | null;
  env: { CODEX_HOME?: string; HOME?: string };
}

export interface InPlaceRestartIo {
  readProcess(pid: number): Promise<ProcessFacts | null>;
  readThreadId(pid: number, startedAt: string, codexHome: string): Promise<string | undefined>;
  /** The same read as readThreadId, with whether it met no detected incompleteness (discovery, open, query). */
  readThreadEvidence(pid: number, startedAt: string, codexHome: string): Promise<CodexThreadEvidence>;
  /** `cli_auth_credentials_store` from the home's config.toml: the value, null when unset, undefined when unreadable. */
  readCredentialStore(codexHome: string): string | null | undefined;
  /** stat (never read) of the home's auth.json. */
  statAuthFile(codexHome: string): { mtimeMs: number } | null;
  findRollout(codexHome: string, conversationId: string): string | null;
  readRolloutTail(path: string): string | null;
}

export interface InPlaceRestartDeps {
  db: BetterSqlite3.Database;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmux: InPlaceRestartTmux;
  codex: InPlaceCodexLauncher;
  activity?: { getSeatState(nodeId: string): ArbitratedSeatState | null } | null;
  listProcesses?: NativeProcessLister;
  io?: Partial<InPlaceRestartIo>;
  timing?: Partial<PaneCutoverTiming>;
  now?: () => Date;
  /** When this daemon process started. A started restart older than this can't still be running. */
  daemonStartedAt?: Date;
}

/** The seat as the caller resolved it, under its lifecycle lease. */
export interface InPlaceRestartTarget {
  seat: { rigId: string; rigName: string; logicalId: string; nodeId: string };
  sessionId: string;
  sessionName: string;
  /** Saved choices for the seat's next managed launch. The restart keeps EFFECTIVE settings, except effort,
   *  which the binding carries from the shared resolver (seat-effort.ts). */
  saved: { model: string | null; effort: string | null; codexConfigProfile: string | null;
    /** Where the saved effort comes from. Only an explicit seat choice may change effort in place. */
    effortSource?: "seat_choice" | "authored" | "runtime_default" };
  binding: NodeBinding;
}

export type InPlaceRestartRefusalCode =
  | "pane_unverified" | "pane_shape_unknown" | "resume_binding_unverified" | "settings_unverified"
  | "settings_drift" | "restart_in_progress" | "relaunch_unavailable" | "tmux_probe_failed";

export interface InPlaceRestartRefusal { ok: false; code: InPlaceRestartRefusalCode; message: string; guidance?: string; detail?: unknown }

export type InPlaceRestartOutcome = "restarted_account_unverified" | "not_started" | "incomplete" | "native_unknown";

type PaneShape = "shell_backed" | "direct_native";

export interface EffectiveSettings {
  model: string | null; profile: string | null; sandbox: string | null; approval: string | null;
  bypass: boolean; config: string[];
}

export interface InPlaceRestartReport {
  ok: true;
  planOnly: boolean;
  outcome?: InPlaceRestartOutcome;
  message: string;
  seat: InPlaceRestartTarget["seat"];
  sessionName: string;
  pane: string;
  paneShape: PaneShape;
  conversationId: string;
  conversationProof: "argv" | "native_logs";
  /** When argv proves the stored conversation: what the process's own retained logs show, as a note. "no other
   *  conversation logged" isn't proof the conversation is current; "not established: …" says why nothing was concluded. */
  currentConversation?: string;
  activity: { state: "working" | "needs_input" | "idle" | "unknown"; needsInput: number | null; detail: string };
  childProcesses: Array<{ pid: number; name: string }>;
  settings: {
    effective: EffectiveSettings; saved: InPlaceRestartTarget["saved"]; note: string;
    /** OPR.0.7.0.7: the effort flag the running Codex was launched with, and the one the relaunch sends. */
    effort: { running: string | null; relaunch: string | null; changes: boolean; source: "seat_choice" | "authored" | "runtime_default" };
  };
  codexHome: string;
  /** Launch evidence only: whether the running Codex's command line carries `--no-daemon`. It doesn't show whether an
   *  app-server process, its login or any lock is involved. */
  codexNoDaemonFlag: { present: boolean; detail: string };
  /** Kept only for CLIs before 0.7.0, whose printer reads `billingRoute.detail` unguarded; remove once they're gone. */
  billingRoute: { state: "unknown"; detail: string };
  account: AccountEvidence;
  peers: PeerReport[];
  oldProcess: { pid: number; startedAt: string | null };
  newProcess?: { pid: number; startedAt: string | null; sameExecutable: boolean | null };
  paneHeld?: { option: "remain-on-exit"; value: "on"; previous: string | null; detail: string };
  /** After a failed direct-native stop or respawn: the pane and the original process, as observed. */
  observedAfterStop?: { pane: "present" | "gone" | "unknown"; process: "running" | "exited" | "unknown"; detail: string };
  /** A restart of this seat that started under an earlier daemon run and never recorded a result. */
  staleRestart?: { startedAt: string; oldPid: number | null; pane: string | null; detail: string };
  /** The seat's latest recorded in-place restart result, if any. */
  lastRestart?: { outcome: string; finishedAt: string };
  remainingStep?: string;
  recoveryCommand?: string;
  couldNotSee?: string[];
  warnings: string[];
}

export interface AccountEvidence {
  verdict: "unverified";
  credentialStore: { value: string | null; state: "read" | "unset" | "unreadable"; detail: string };
  authFile: { changedBeforeRestart: boolean | null; detail: string };
  startupGate: string | null;
  /** The native resume probe's code for that gate (for example `hook_trust_gate`), when the launch named one. */
  startupGateKind: string | null;
  notVerified: string[];
}

export interface PeerReport {
  logicalId: string;
  sessionName: string | null;
  home: "same" | "different" | "unknown";
  effect: string;
}

export type InPlaceVerifyResult =
  | {
      ok: true;
      seat: InPlaceRestartTarget["seat"];
      outcome: "moved" | "restarted_account_unverified";
      message: string;
      toolTurn: { completed: number; errors: number; since: string; state: "observed" | "not_observed" | "unreadable" };
      accountEvidence: { state: "matched" | "not_matched" | "not_requested" | "not_observed"; detail: string };
    }
  | { ok: false; code: "no_restart_recorded" | "restart_not_completed" | "seat_restarted_since"; message: string };

const RESTART_STARTED = "seat.restart_in_place_started" as const;
const RESTART_FINISHED = "seat.restart_in_place_finished" as const;
const BILLING_ROUTE_FOR_OLDER_CLIS = { state: "unknown", detail: "Not reported." } as const;
const NOT_VERIFIED = [
  "Which account the restarted Codex actually uses: only `--verify` with --expect-account and a completed tool turn can confirm it.",
  "Whether Codex saved the conversation before it exited (TERM, then KILL after the timeout).",
];

interface Observed {
  ok: true; report: InPlaceRestartReport; codexPid: number; codexStartedAt: string | null; panePid: number;
  relaunch: { command: string; core: string }; priorRemainOnExit: string | null;
  cwd: string; oldExe: string | null;
}

interface RestartProgress { stage: string; paneHeld: InPlaceRestartReport["paneHeld"] }

export class CodexInPlaceRestart {
  private readonly io: InPlaceRestartIo;
  private readonly timing: PaneCutoverTiming;
  private readonly listProcesses: NativeProcessLister;
  private readonly now: () => Date;
  private readonly daemonStartedAt: Date;

  constructor(private readonly deps: InPlaceRestartDeps) {
    this.io = { ...defaultInPlaceRestartIo(), ...deps.io };
    this.timing = {
      pollMs: deps.timing?.pollMs ?? 100,
      timeoutMs: deps.timing?.timeoutMs ?? 3_000,
      sleep: deps.timing?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
    this.listProcesses = deps.listProcesses ?? listNativeProcesses;
    this.now = deps.now ?? (() => new Date());
    this.daemonStartedAt = deps.daemonStartedAt ?? new Date(Date.now() - process.uptime() * 1000);
  }

  /** The newest started-event seq for a node; a request records it before waiting for the lifecycle lease. */
  latestStartedSeq(nodeId: string): number {
    const row = this.deps.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE node_id = ? AND type = ?")
      .get(nodeId, RESTART_STARTED) as { seq: number | null } | undefined;
    return row?.seq ?? 0;
  }

  /** Every gate, read-only. Returns the report a restart would start from, or the refusal it would give. */
  async plan(target: InPlaceRestartTarget): Promise<InPlaceRestartReport | InPlaceRestartRefusal> {
    const observed = await this.observe(target, null);
    if (!observed.ok) return observed;
    return { ...observed.report, message: "Preview only: nothing was stopped or restarted." };
  }

  async execute(target: InPlaceRestartTarget, input: { reason: string; operator: string | null; seenStartedSeq: number }): Promise<InPlaceRestartReport | InPlaceRestartRefusal> {
    const observed = await this.observe(target, input.seenStartedSeq);
    if (!observed.ok) return observed;
    const { report } = observed;
    const { sessionName, seat } = target;
    this.persist({
      type: RESTART_STARTED, rigId: seat.rigId, nodeId: seat.nodeId, logicalId: seat.logicalId, sessionName,
      pane: report.pane, paneShape: report.paneShape, oldPid: observed.codexPid, oldStartedAt: observed.codexStartedAt,
      codexHome: report.codexHome, reason: input.reason.trim(), operator: input.operator,
    });
    // From here every exit records a result, including a throw: a started restart with no result would
    // otherwise refuse every later restart and preview of this seat.
    const progress: RestartProgress = { stage: "stop", paneHeld: undefined };
    let result: InPlaceRestartReport;
    try {
      result = await this.restart(target, observed, progress);
    } catch (error) {
      result = {
        ...report, outcome: "native_unknown", recoveryCommand: observed.relaunch.core,
        ...(progress.paneHeld ? { paneHeld: progress.paneHeld } : {}),
        couldNotSee: [`what happened after an error during ${progress.stage}: ${error instanceof Error ? error.message : String(error)}`],
        message: `The restart stopped with an error during ${progress.stage}; the seat's state was not observed afterwards.`,
      };
    }
    // Where the pane's text stood when the restart finished: an anchor at the end of its history, and the
    // Account lines after it. --verify counts only lines beyond these, so text that was there before is never
    // evidence, however much older history tmux has trimmed since.
    const accountTextAtRestart = result.outcome === "restarted_account_unverified"
      ? accountTextMark(await this.deps.tmux.capturePaneHistoryParts(result.pane).catch(() => null))
      : null;
    this.persist({
      type: RESTART_FINISHED, rigId: seat.rigId, nodeId: seat.nodeId, logicalId: seat.logicalId, sessionName,
      outcome: result.outcome!, newPid: result.newProcess?.pid ?? null, newStartedAt: result.newProcess?.startedAt ?? null,
      codexHome: result.codexHome, paneHeld: result.paneHeld ? true : false, accountTextAtRestart, finishedAt: this.now().toISOString(),
    });
    return result;
  }

  /** The restart after its started event. Updates `progress` so a throw is reported at its stage. */
  private async restart(target: InPlaceRestartTarget, observed: Observed, progress: RestartProgress): Promise<InPlaceRestartReport> {
    const { report, codexPid, codexStartedAt, panePid, relaunch, priorRemainOnExit, cwd, oldExe } = observed;
    const { sessionName } = target;
    const pane = report.pane;
    // What resumes the original by hand: the exact relaunch command, without the seat environment wrapper.
    const recoveryCommand = relaunch.core;

    let launch: HarnessLaunchResult;
    if (report.paneShape === "shell_backed") {
      const stopped = await this.stopUnderShell(pane, panePid, codexPid, codexStartedAt);
      if (stopped === "running") {
        return { ...report, outcome: "not_started", recoveryCommand, message: "Codex did not exit after TERM and KILL; nothing was restarted and the original process is still running." };
      }
      if (stopped === "unknown") {
        return { ...report, outcome: "native_unknown", recoveryCommand, couldNotSee: ["whether the original Codex exited and the pane's shell is back in the foreground"],
          message: "Signals were sent, but the pane could not be observed afterwards; no resume was attempted." };
      }
      // The shell is back: type the exact resume command the checks ran on, built from the running Codex's
      // choices, and prove the resume. Preparing the launch again here would decide those choices afresh.
      progress.stage = "resume";
      // The relaunch runs in the home the running Codex used (anything else refused as drift), so the proof reads that one.
      launch = await this.deps.codex.sendResumeCommand(sessionName, relaunch.command, report.conversationId, target.seat.nodeId, report.codexHome);
      if (!launch.ok) return this.incomplete(report, launch, recoveryCommand);
      progress.stage = "identity check";
      return this.verifyReplacement(target, report, oldExe);
    }

    // Hold the pane before any signal: without remain-on-exit, Codex exiting would destroy the pane and
    // there would be nothing to respawn into. The hold counts only once tmux reads it back as on.
    progress.stage = "pane hold";
    const set = await this.deps.tmux.setRemainOnExit(pane, true);
    const readBack = await this.deps.tmux.getPaneLocalOption(pane, "remain-on-exit");
    if (readBack !== "on") {
      const undo = readBack !== priorRemainOnExit ? await this.deps.tmux.restorePaneOption(pane, "remain-on-exit", priorRemainOnExit) : { ok: true as const };
      const why = !set.ok ? set.message : readBack === undefined ? "the setting could not be read back" : `it reads back as ${readBack ?? "unset"}`;
      return { ...report, outcome: "not_started", recoveryCommand,
        ...(undo.ok ? {} : { warnings: [...report.warnings, `remain-on-exit could not be put back to ${priorRemainOnExit ?? "unset"}: ${undo.message}`] }),
        message: `Nothing was stopped: the pane could not be held with remain-on-exit (${why}), so the original Codex was not signalled and is still running.` };
    }
    const held = { option: "remain-on-exit" as const, value: "on" as const, previous: priorRemainOnExit,
      detail: "Left on so the pane survives for recovery; restored only after a verified live replacement." };
    progress.paneHeld = held;
    progress.stage = "stop";
    const terminated = await terminatePaneInPlace(this.deps.tmux, pane, this.timing, "Codex");
    if (!terminated.ok) return this.afterFailedStop(target, report, observed, held, recoveryCommand, terminated.message, progress);
    // Respawn the dead pane WITHOUT -k (scrollback stays) with the resume command as its own command.
    progress.stage = "respawn";
    const respawned = await this.deps.tmux.respawnPane(pane, relaunch.command, { cwd });
    if (!respawned.ok) {
      return this.afterFailedStop(target, report, observed, held, recoveryCommand, `the pane could not be respawned: ${respawned.message}`, progress);
    }
    if (respawned.warnings) report.warnings.push(...respawned.warnings);
    progress.stage = "resume";
    launch = await this.deps.codex.verifyResumeInPane(sessionName, report.conversationId, target.seat.nodeId, report.codexHome);
    if (!launch.ok) return this.incomplete(report, launch, recoveryCommand, held);
    progress.stage = "identity check";
    const verified = await this.verifyReplacement(target, report, oldExe);
    if (verified.outcome !== "restarted_account_unverified") return { ...verified, paneHeld: held };
    progress.stage = "restoring remain-on-exit";
    const restored = await this.deps.tmux.restorePaneOption(pane, "remain-on-exit", priorRemainOnExit);
    if (!restored.ok) {
      return { ...verified, paneHeld: { ...held, detail: `The replacement is verified, but remain-on-exit could not be restored: ${restored.message}` } };
    }
    progress.paneHeld = undefined;
    return verified;
  }

  /**
   * `--verify`: after the operator has had the restarted seat complete a real tool-using turn (and, for
   * account evidence, shown Codex's /status), read what Codex recorded. `moved` needs BOTH a completed
   * tool call in this conversation since the restart, with no error event, AND an account line on the
   * pane that names the expected account. Nothing is typed into the seat.
   */
  async verify(target: InPlaceRestartTarget, input: { expectAccount?: string | null }): Promise<InPlaceVerifyResult> {
    const rows = this.deps.db.prepare("SELECT type, payload FROM events WHERE node_id = ? AND type IN (?, ?) ORDER BY seq DESC LIMIT 1")
      .all(target.seat.nodeId, RESTART_STARTED, RESTART_FINISHED) as Array<{ type: string; payload: string }>;
    const latest = rows[0];
    if (!latest) return { ok: false, code: "no_restart_recorded", message: "This seat has no recorded in-place restart to verify." };
    if (latest.type === RESTART_STARTED) return { ok: false, code: "restart_not_completed", message: "The latest in-place restart of this seat has not finished." };
    const finished = JSON.parse(latest.payload) as { outcome: string; newPid: number | null; newStartedAt: string | null; codexHome: string; finishedAt: string; accountLinesAtRestart?: Record<string, number> | null; accountTextAtRestart?: AccountTextMark | null };
    if (finished.outcome !== "restarted_account_unverified") {
      return { ok: false, code: "restart_not_completed", message: `The latest in-place restart ended ${finished.outcome}; there is nothing to verify.` };
    }
    const current = await this.observeCodex(target.binding.tmuxPane!, null);
    if (!current || current.process.pid !== finished.newPid || (current.process.startedAt ?? null) !== finished.newStartedAt) {
      return { ok: false, code: "seat_restarted_since", message: "The seat's Codex is no longer the process the restart started; verify the current occupant another way." };
    }
    const conversationId = readResumeToken(this.deps.db, target.sessionId);
    const toolTurn = this.readToolTurn(finished.codexHome, conversationId, finished.finishedAt);
    // A restart recorded before the anchor existed carries only whole-pane counts; those are still compared as before.
    const atRestart = finished.accountTextAtRestart !== undefined ? finished.accountTextAtRestart
      : finished.accountLinesAtRestart != null ? { anchor: null, counts: finished.accountLinesAtRestart } : null;
    const accountEvidence = await this.readAccountLine(target.binding.tmuxPane!, atRestart, input.expectAccount ?? null);
    const moved = toolTurn.state === "observed" && toolTurn.completed > 0 && toolTurn.errors === 0 && accountEvidence.state === "matched";
    return {
      ok: true, seat: target.seat, outcome: moved ? "moved" : "restarted_account_unverified", toolTurn, accountEvidence,
      message: moved
        ? "Moved: a tool turn completed in the same conversation since the restart, and Codex's status names the expected account."
        : "Account unverified: moved needs a completed tool turn since the restart AND Codex's status naming the expected account (--expect-account).",
    };
  }

  // -- observation (shared by plan and execute) --

  private async observe(target: InPlaceRestartTarget, seenStartedSeq: number | null): Promise<Observed | InPlaceRestartRefusal> {
    const { binding, sessionName, seat } = target;
    const history = this.restartHistory(seat.nodeId, seenStartedSeq);
    if ("code" in history) return history;

    const pane = binding.tmuxPane;
    let panes: Awaited<ReturnType<InPlaceRestartTmux["listPanes"]>>;
    try { panes = await this.deps.tmux.listPanes(sessionName); } catch (error) {
      return { ok: false, code: "tmux_probe_failed", message: `tmux pane lookup failed: ${(error as Error).message}; nothing was stopped.` };
    }
    if (!pane || panes.length !== 1 || panes[0]?.id !== pane) {
      return { ok: false, code: "pane_unverified", message: `Session "${sessionName}" must have exactly the seat's bound pane ${pane ?? "(none)"}; observed ${panes.map((p) => p.id).join(", ") || "no panes"}. Nothing was stopped.` };
    }

    const token = readResumeToken(this.deps.db, target.sessionId);
    if (!token) {
      return { ok: false, code: "resume_binding_unverified", message: "The seat's session has no stored Codex conversation id, so there is nothing to resume in place.",
        guidance: "Record the conversation with: rig seat set-resume-token" };
    }
    const codex = await this.observeCodex(pane, token);
    if (!codex) {
      return { ok: false, code: "resume_binding_unverified", message: "No single Codex process in the seat's pane could be tied to the stored conversation (a running Codex that names another conversation is refused too). Nothing was stopped." };
    }
    const { process, panePid, rows } = codex;
    const startedAt = process.startedAt ?? null;
    const facts = await this.io.readProcess(process.pid);
    if (!facts) return { ok: false, code: "settings_unverified", message: "The running Codex's working directory and Codex home could not be read (this observer reads /proc on Linux). Nothing was stopped." };
    const codexHome = facts.env.CODEX_HOME ?? (facts.env.HOME ? nodePath.join(facts.env.HOME, ".codex") : null);
    if (!codexHome) return { ok: false, code: "settings_unverified", message: "The running Codex's home could not be determined (no CODEX_HOME or HOME). Nothing was stopped." };

    // The conversation the PROCESS is on: argv for a resumed Codex, its own native logs for a fresh one.
    const argvToken = codexCommandResumeToken(process.command);
    let conversationProof: "argv" | "native_logs";
    if (argvToken === token) conversationProof = "argv";
    else if (argvToken === undefined && startedAt && (await this.io.readThreadId(process.pid, startedAt, codexHome)) === token) conversationProof = "native_logs";
    else return { ok: false, code: "resume_binding_unverified", message: "The running Codex could not be proven to be on the seat's stored conversation (checked: its argv, then its native logs). Nothing was stopped." };

    // Its argv resumes the stored conversation, but its own logs may say it has moved on. Refuse only when a read with no
    // detected incompleteness (every database found, opened and queried) names only another conversation; anything less
    // keeps the restart, with a note. Not an atomic snapshot: a switch not yet logged, or rows inside the process's start
    // second (excluded by the reuse gate), stay invisible.
    let currentConversation: string | undefined;
    if (conversationProof === "argv") {
      let evidence: CodexThreadEvidence;
      if (!startedAt) evidence = { reason: "no_log_row", fullyReadable: false };
      else {
        try { evidence = await this.io.readThreadEvidence(process.pid, startedAt, codexHome); }
        catch { evidence = { reason: "sqlite_unreadable", fullyReadable: false, incomplete: "unreadable" }; }
      }
      if (evidence.fullyReadable && evidence.thread && evidence.thread !== token) {
        return { ok: false, code: "resume_binding_unverified", detail: { reason: "conflicting retained native-thread evidence", loggedConversation: evidence.thread },
          message: `Conflicting retained native-thread evidence: the running Codex's command line resumes the seat's stored conversation ${token}, but its own logs, read with no detected incompleteness, name only ${evidence.thread}. Nothing was stopped and nothing was typed.`,
          guidance: "This doesn't show which conversation is current or that the stored one is gone. Check the seat's conversation (rig seat set-resume-token records one) before restarting it in place." };
      }
      currentConversation = evidence.thread === token && evidence.fullyReadable ? "no other conversation logged"
        : evidence.thread ? (evidence.incomplete === "unreadable" ? "not established: a native database was unreadable"
          : "not established: the native databases couldn't all be found")
        : `not established: ${evidence.reason ?? "no_log_row"}`;
    }

    // Pane shape: the pane's root is Codex itself, or a shell whose child chain is Codex.
    const chain = codexChain(rows, process, panePid);
    const top = chain.at(-1)!;
    const root = rows.find((row) => row.pid === panePid);
    let paneShape: PaneShape;
    // OpenRig types a Codex launch (and this restart's relaunch) as `/bin/sh <staged script>`, so a managed
    // Codex runs one sh below the pane's shell. Only that script is accepted between them.
    const between = rows.find((row) => row.pid === top.ppid);
    const viaLaunchScript = !!between && between.ppid === panePid && isStagedLaunchScript(between);
    if (top.pid === panePid) paneShape = "direct_native";
    else if (root && (top.ppid === panePid || viaLaunchScript) && isShellForeground(executableBase(root))) paneShape = "shell_backed";
    else return { ok: false, code: "pane_shape_unknown", message: "The pane is neither a shell running Codex (directly or through OpenRig's own launch script) nor Codex itself; nothing was stopped." };

    // Where the relaunched Codex would run, and with which home.
    let cwd: string;
    let shellFacts: ProcessFacts | null = null;
    if (paneShape === "shell_backed") {
      shellFacts = await this.io.readProcess(panePid);
      if (!shellFacts?.cwd) return { ok: false, code: "settings_unverified", message: "The pane shell's working directory could not be read. Nothing was stopped." };
      cwd = shellFacts.cwd;
    } else {
      if (!facts.cwd) return { ok: false, code: "settings_unverified", message: "The running Codex's working directory could not be read. Nothing was stopped." };
      cwd = facts.cwd;
    }
    const relaunchBinding: NodeBinding = { ...binding, cwd };
    // The probed and prepared launch choices come from the running Codex, so the relaunch keeps them and no
    // Codex process is started to decide them again.
    const runningArgv = processArgv(process.command);
    const running = runningLaunch(runningArgv);
    const relaunch = await this.deps.codex.buildResumeCommand(relaunchBinding, { name: sessionName, resumeToken: token, running });
    if (!relaunch.ok) return { ok: false, code: "relaunch_unavailable", message: `The resume command could not be built: ${relaunch.error}. Nothing was stopped.` };
    const relaunchHome = envAssignment(relaunch.command, "CODEX_HOME")
      ?? (paneShape === "shell_backed"
        ? shellFacts!.env.CODEX_HOME ?? (shellFacts!.env.HOME ? nodePath.join(shellFacts!.env.HOME, ".codex") : null)
        : (await this.deps.tmux.getSessionEnv(sessionName, "CODEX_HOME")) ?? null);

    const effective = parseEffectiveSettings(runningArgv);
    const relaunched = parseEffectiveSettings(shellWords(relaunch.core));
    // The relaunch sends the seat's resolved effort. Only an explicit saved seat choice may change effort
    // in place; with none (never set, or cleared) an effort difference is drift, as for any setting.
    const runningEffort = emittedEffortFromArgv("codex", runningArgv);
    const relaunchEffort = emittedEffortFromArgv("codex", shellWords(relaunch.core));
    const effort = {
      running: runningEffort.flag === "present" ? runningEffort.value : null,
      relaunch: relaunchEffort.flag === "present" ? relaunchEffort.value : null,
      changes: false,
      source: target.saved.effortSource ?? (target.saved.effort ? "authored" as const : "runtime_default" as const),
    };
    effort.changes = effort.running !== effort.relaunch;
    const applyChoice = effort.changes && effort.source === "seat_choice";
    const drift = [
      ...settingsDrift(effective, relaunched).filter((key) => key !== "effort" || !applyChoice),
      ...(facts.cwd && facts.cwd !== cwd ? ["cwd"] : []),
      ...(relaunchHome !== codexHome ? ["codex home"] : []),
    ];
    if (drift.length > 0) {
      return { ok: false, code: "settings_drift", detail: { differs: drift },
        message: `Relaunching now would change ${drift.join(", ")} from what the running Codex uses, so this account-only restart refuses. Nothing was stopped.`,
        guidance: drift.includes("effort")
          ? "This seat has no saved effort choice (never set, or cleared), so an account-only restart keeps the running effort and won't change it. Save one with rig seat set-effort to apply it here; otherwise the next ordinary managed launch or resume resolves effort. Run rig seat restart --plan to compare."
          : "A saved model/profile choice applies at a managed launch that is meant to change settings, not here. Run rig seat restart --plan to compare." };
    }

    let priorRemainOnExit: string | null = null;
    if (paneShape === "direct_native") {
      const prior = await this.deps.tmux.getPaneLocalOption(pane, "remain-on-exit");
      if (prior === undefined) return { ok: false, code: "tmux_probe_failed", message: "The pane's remain-on-exit setting could not be read, so it could not be put back; nothing was stopped." };
      priorRemainOnExit = prior;
    }

    const report: InPlaceRestartReport = {
      ok: true, planOnly: seenStartedSeq === null, message: "", seat, sessionName, pane, paneShape,
      conversationId: token, conversationProof,
      activity: this.activity(seat.nodeId),
      childProcesses: descendants(rows, process.pid, chain).map((row) => ({ pid: row.pid, name: executableBase(row) })),
      settings: { effective, saved: target.saved, effort,
        note: applyChoice
          ? `The restart keeps the settings the running Codex uses (effective), except effort: it sends the seat's saved effort choice ${effort.relaunch} in place of ${effort.running ?? "no flag"}. Other saved choices are shown, not applied.`
          : "The restart keeps the settings the running Codex uses (effective), effort included. Saved choices for the next managed launch are shown, not applied." },
      codexHome,
      codexNoDaemonFlag: running.daemonOptOut
        ? { present: true, detail: "Launch evidence: the running Codex was started with --no-daemon. This doesn't show whether an app-server process, its login or any lock is involved." }
        : { present: false, detail: "Launch evidence: the running Codex's command line has no --no-daemon. This doesn't show whether an app-server process, its login or any lock is involved." },
      billingRoute: BILLING_ROUTE_FOR_OLDER_CLIS,
      account: this.accountEvidence(codexHome, startedAt, null),
      ...(currentConversation ? { currentConversation } : {}),
      peers: await this.peers(seat.nodeId, codexHome),
      oldProcess: { pid: process.pid, startedAt },
      ...history,
      warnings: [],
    };
    return { ok: true, report, codexPid: top.pid, codexStartedAt: top.startedAt ?? null, panePid, relaunch, priorRemainOnExit, cwd, oldExe: facts.exe };
  }

  /** Refuses while a restart of this seat is in flight under THIS daemon, or ran while the request waited.
   *  A started restart from before this daemon started can't still be running: it is reported, not refused. */
  private restartHistory(nodeId: string, seenStartedSeq: number | null):
    | Pick<InPlaceRestartReport, "staleRestart" | "lastRestart"> | InPlaceRestartRefusal {
    const rows = this.deps.db.prepare("SELECT seq, type, payload, created_at FROM events WHERE node_id = ? AND type IN (?, ?) ORDER BY seq DESC LIMIT 2")
      .all(nodeId, RESTART_STARTED, RESTART_FINISHED) as Array<{ seq: number; type: string; payload: string; created_at: string }>;
    const latest = rows[0];
    const lastFinished = rows.find((row) => row.type === RESTART_FINISHED);
    const lastRestart = lastFinished ? (() => {
      const payload = JSON.parse(lastFinished.payload) as { outcome: string; finishedAt: string };
      return { lastRestart: { outcome: payload.outcome, finishedAt: payload.finishedAt } };
    })() : {};
    if (seenStartedSeq !== null && this.latestStartedSeq(nodeId) > seenStartedSeq) {
      return { ok: false, code: "restart_in_progress", message: "Another in-place restart of this seat ran while this request waited; not restarting again. Inspect its result first (--plan shows it as lastRestart)." };
    }
    if (latest?.type !== RESTART_STARTED) return lastRestart;
    const startedAt = new Date(`${latest.created_at.replace(" ", "T")}Z`);
    const started = JSON.parse(latest.payload) as { oldPid?: number; pane?: string };
    if (!(startedAt.getTime() < this.daemonStartedAt.getTime())) {
      return { ok: false, code: "restart_in_progress", message: `An in-place restart of this seat started at ${startedAt.toISOString()} under this daemon and has not recorded a result yet; it is still running. --plan shows its result once it finishes.` };
    }
    return { ...lastRestart, staleRestart: {
      startedAt: startedAt.toISOString(), oldPid: started.oldPid ?? null, pane: started.pane ?? null,
      detail: `Started before this daemon did (${this.daemonStartedAt.toISOString()}) and never recorded a result, so it is not running. The seat's state above is observed now.`,
    } };
  }

  private async observeCodex(pane: string, token: string | null) {
    const rows = await this.listProcesses();
    const panePid = await this.deps.tmux.getPanePid(pane);
    if (!panePid) return null;
    const observation = await verifyCodexPaneProcess({ target: pane, tmux: { getPanePid: async () => panePid },
      listProcesses: () => rows, ...(token ? { expectedToken: token } : {}) });
    return observation && observation.panePid === panePid ? { process: observation.process, panePid, rows } : null;
  }

  /** Shell-backed: TERM the Codex chain's top process (not the pane's shell), KILL after the timeout, then
   *  require the original process gone AND the shell back in the foreground. */
  private async stopUnderShell(pane: string, panePid: number, pid: number, startedAt: string | null): Promise<"stopped" | "running" | "unknown"> {
    const gone = async (): Promise<boolean | null> => {
      const rows = await this.listProcesses();
      if (rows.length === 0) return null;
      if (rows.some((row) => row.pid === pid && (row.startedAt ?? null) === startedAt)) return false;
      const command = await this.deps.tmux.getPaneCommand(pane);
      const root = rows.find((row) => row.pid === panePid);
      return command !== null && isShellForeground(command) && !!root;
    };
    const wait = async (): Promise<boolean | null> => {
      const polls = Math.max(1, Math.ceil(this.timing.timeoutMs / this.timing.pollMs));
      let last: boolean | null = null;
      for (let i = 0; i <= polls; i++) {
        last = await gone();
        if (last) return true;
        if (i < polls) await this.timing.sleep(this.timing.pollMs);
      }
      return last;
    };
    await this.deps.tmux.signalPid(pid, "TERM");
    if (await wait()) return "stopped";
    await this.deps.tmux.signalPid(pid, "KILL");
    const last = await wait();
    return last ? "stopped" : last === null ? "unknown" : "running";
  }

  private async verifyReplacement(target: InPlaceRestartTarget, report: InPlaceRestartReport, oldExe: string | null): Promise<InPlaceRestartReport> {
    // Screen readiness can precede native-process visibility. Repeat only the joined
    // observations, never the launch. The budget counts yields, not observation I/O.
    const polls = Math.max(1, Math.ceil(this.timing.timeoutMs / this.timing.pollMs));
    for (let attempt = 0; ; attempt++) {
      const identity = await rebindAndVerifyPaneIdentity({
        db: this.deps.db, sessionRegistry: this.deps.sessionRegistry, tmux: this.deps.tmux,
        nodeId: target.seat.nodeId, sessionName: target.sessionName, runtime: "codex",
        expectedResumeToken: report.conversationId, requireExactResumeLineage: true, listProcesses: this.listProcesses,
        // The check repeats up to 31 times; only the final attempt, whose text the report shows, pays the extra read.
        explainFailure: attempt >= polls,
      });
      const now = await this.observeCodex(report.pane, report.conversationId);
      if (!identity.ok || !now) {
        if (attempt < polls) {
          await this.timing.sleep(this.timing.pollMs);
          continue;
        }
        return { ...report, outcome: "native_unknown", couldNotSee: [`the replacement Codex's identity: ${identity.ok ? "process not observed" : identity.detail}`],
          message: "Codex reported a resumed conversation, but the process in the pane could not be proven to be that conversation." };
      }
      const after = await this.io.readProcess(now.process.pid);
      const before = report.oldProcess;
      const startedAt = now.process.startedAt ?? null;
      return {
        ...report, outcome: "restarted_account_unverified",
        newProcess: { pid: now.process.pid, startedAt, sameExecutable: after?.exe && oldExe ? after.exe === oldExe : null },
        account: this.accountEvidence(report.codexHome, before.startedAt, startedAt),
        message: "Restarted in place on the same conversation and pane. The account is not verified: run --verify after a real tool-using turn.",
      };
    }
  }

  /** A direct-native stop or respawn that failed: report what the pane and the original process are now,
   *  as observed, never an assumed state. A pane that is gone holds nothing. */
  private async afterFailedStop(target: InPlaceRestartTarget, report: InPlaceRestartReport, observed: Observed,
    held: NonNullable<InPlaceRestartReport["paneHeld"]>, recoveryCommand: string, failure: string, progress: RestartProgress): Promise<InPlaceRestartReport> {
    const seen = await this.observeAfterStop(target.sessionName, report.pane, observed.codexPid, observed.codexStartedAt);
    const observedAfterStop = { ...seen, detail: `pane ${seen.pane}, original Codex ${seen.process}` };
    const paneHeld = seen.pane === "gone" ? undefined : held;
    progress.paneHeld = paneHeld;
    const base = { ...report, recoveryCommand, observedAfterStop, ...(paneHeld ? { paneHeld } : {}) };
    if (seen.process === "running" && seen.pane === "present") {
      return { ...base, outcome: "not_started", message: `The original Codex is still running (observed): ${failure}` };
    }
    if (seen.process === "exited" && seen.pane === "gone") {
      return { ...base, outcome: "incomplete",
        remainingStep: "The seat's pane is gone and nothing replaced it. Resume the conversation in a new pane for this seat with the recovery command.",
        message: `The original Codex exited and its pane is gone (observed); nothing was resumed: ${failure}` };
    }
    if (seen.process === "exited") {
      return { ...base, outcome: "incomplete", remainingStep: "Resolve the pane, then resume with the recovery command. Nothing was retried.",
        message: `The original Codex exited (observed), but the resume was not started: ${failure}` };
    }
    return { ...base, outcome: "native_unknown", couldNotSee: [`the seat's state after the stop (${observedAfterStop.detail})`],
      message: `The stop did not complete as expected and the seat's state is not fully known: ${failure}` };
  }

  private async observeAfterStop(sessionName: string, pane: string, pid: number, startedAt: string | null):
    Promise<{ pane: "present" | "gone" | "unknown"; process: "running" | "exited" | "unknown" }> {
    let paneState: "present" | "gone" | "unknown";
    try {
      paneState = (await this.deps.tmux.listPanes(sessionName)).some((candidate) => candidate.id === pane) ? "present" : "gone";
    } catch (error) {
      paneState = /can't find|not found|no such/i.test((error as Error).message) ? "gone" : "unknown";
    }
    const rows = await (async () => this.listProcesses())().catch(() => [] as NativeProcessRow[]);
    const processState = rows.length === 0 ? "unknown"
      : rows.some((row) => row.pid === pid && (row.startedAt ?? null) === startedAt) ? "running" : "exited";
    return { pane: paneState, process: processState };
  }

  private incomplete(report: InPlaceRestartReport, launch: Extract<HarnessLaunchResult, { ok: false }>, recoveryCommand: string | undefined,
    paneHeld?: InPlaceRestartReport["paneHeld"]): InPlaceRestartReport {
    const signIn = /sign in/i.test(launch.error);
    const missing = launch.recovery === "retry_fresh";
    const attention = launch.recovery === "attention_required";
    // The native decision a named startup gate is waiting for. Nothing answers it: the step names it.
    const named = attention && launch.gate ? startupGateStep(launch, report.sessionName, report.pane, recoveryCommand) : null;
    // The pane did restart here, so an unproven or disproved resume is reported without the adapter's closing
    // "nothing was restarted", which is true only for a caller that restarted nothing.
    const restarted = launch.resumeUnproven || launch.resumeMismatch;
    const error = launch.resumeDetail ?? launch.error;
    return {
      ...report, outcome: "incomplete", recoveryCommand, ...(paneHeld ? { paneHeld } : {}),
      account: { ...report.account, startupGate: attention ? error : null, startupGateKind: attention ? launch.gate ?? null : null },
      remainingStep: signIn
        ? `Whoever owns the sign-in signs in to Codex in ${report.codexHome}, then the conversation resumes with the recovery command.`
        : missing
          ? `Codex in ${report.codexHome} has no saved session for this conversation; no fresh session was started. Find where it was saved before resuming.`
          : named
            // #1524 (b): disproved: the resumed process's records name another conversation.
            ?? (launch.resumeMismatch
              ? `The resumed Codex opened ${launch.resumeMismatch.opened}, not the seat's conversation ${report.conversationId}; find the seat's conversation before resuming again. Nothing was retried.`
            // #1524 (b): not disproved, only unproven; the resumed Codex may still be running it.
            : launch.resumeUnproven
              ? `The resumed Codex may still be running in the pane: its records didn't prove the conversation in time. Check the pane first; if the conversation is there, adopt it with rig reconcile-session ${report.sessionName} --no-launch. Use the recovery command only if the original is gone. ${attention && keyTyped(launch) ? typedSentence(launch) : "Nothing was retried."}`
              : null)
            ?? (attention && keyTyped(launch)
              // OpenRig's own key is part of what the person needs to know, even with no screen named.
              ? `Resolve what Codex shows in the pane, then resume with the recovery command. ${typedSentence(launch)}`
              : "Resolve what Codex shows in the pane, then resume with the recovery command. Nothing was retried."),
      message: restarted
        ? `The pane restarted: the original Codex exited and the resume started in the same pane, but ${launch.resumeMismatch ? "it opened another conversation" : "it wasn't proven"}: ${error} Check the pane with rig capture ${report.sessionName}.`
        : `The original Codex exited, but the resume was not proven: ${launch.error}`,
    };
  }

  private activity(nodeId: string): InPlaceRestartReport["activity"] {
    const state = this.deps.activity?.getSeatState(nodeId) ?? null;
    if (!state) return { state: "unknown", needsInput: null, detail: "No activity evidence for this seat." };
    const decided = state.decidedBy ? ` (decided by ${state.decidedBy})` : "";
    if (state.needsInput.count > 0) return { state: "needs_input", needsInput: state.needsInput.count, detail: `${state.needsInput.reason ?? "Waiting for input"}${decided}.` };
    if (state.activity === "working") return { state: "working", needsInput: state.needsInput.count, detail: `Mid-turn${decided}: restarting interrupts the turn.` };
    if (state.activity === "idle-at-prompt") return { state: "idle", needsInput: state.needsInput.count, detail: `Idle at the prompt${decided}.` };
    return { state: "unknown", needsInput: state.needsInput.count, detail: `Activity is "${state.activity}"${decided}.` };
  }

  private accountEvidence(codexHome: string, oldStartedAt: string | null, newStartedAt: string | null): AccountEvidence {
    const store = this.io.readCredentialStore(codexHome);
    const auth = this.io.statAuthFile(codexHome);
    const oldStart = oldStartedAt ? Date.parse(oldStartedAt) : NaN;
    const newStart = newStartedAt ? Date.parse(newStartedAt) : NaN;
    return {
      verdict: "unverified",
      credentialStore: store === undefined
        ? { value: null, state: "unreadable", detail: "config.toml could not be read; the credential backend in effect is unknown." }
        : store === null
          ? { value: null, state: "unset", detail: "config.toml sets no cli_auth_credentials_store; Codex's default applies. Administrator requirements were not read." }
          : { value: store, state: "read", detail: store === "file" ? "File-backed: a switched auth.json is what Codex reads." : `Backend "${store}": a copied auth.json may not change the account in use.` },
      authFile: !auth
        ? { changedBeforeRestart: null, detail: "No auth.json to stat in this home." }
        : Number.isNaN(newStart)
          ? { changedBeforeRestart: Number.isNaN(oldStart) ? null : auth.mtimeMs > oldStart,
              detail: "Whether auth.json changed after the running Codex started (stat only; never read). A change is not proof of which account." }
          : { changedBeforeRestart: auth.mtimeMs < newStart, detail: "auth.json was last modified before the replacement started (stat only; never read)." },
      startupGate: null,
      startupGateKind: null,
      notVerified: NOT_VERIFIED,
    };
  }

  private async peers(nodeId: string, codexHome: string): Promise<PeerReport[]> {
    const rows = this.deps.db.prepare(`
      SELECT n.id, n.logical_id, b.tmux_session, b.tmux_pane FROM nodes n
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE n.runtime = 'codex' AND n.id != ? ORDER BY n.logical_id`).all(nodeId) as
      Array<{ id: string; logical_id: string; tmux_session: string | null; tmux_pane: string | null }>;
    const reports: PeerReport[] = [];
    for (const row of rows) {
      let home: PeerReport["home"] = "unknown";
      if (row.tmux_pane && row.tmux_session) {
        const observed = await this.observeCodex(row.tmux_pane, null).catch(() => null);
        const facts = observed ? await this.io.readProcess(observed.process.pid) : null;
        const peerHome = facts?.env.CODEX_HOME ?? (facts?.env.HOME ? nodePath.join(facts.env.HOME, ".codex") : null);
        if (peerHome) home = peerHome === codexHome ? "same" : "different";
      }
      reports.push({ logicalId: row.logical_id, sessionName: row.tmux_session, home,
        effect: home === "same"
          ? `Not restarted; account unverified. Shares home ${codexHome}: if the home's login changed, it keeps its current login only until its next token refresh, when Codex stops it with "signed in to another account" until it's restarted. Signing in again there would replace the home's login.`
          : home === "different" ? "Not restarted; uses a different Codex home." : "Not restarted; account unverified; its Codex home could not be observed." });
    }
    return reports;
  }

  private readToolTurn(codexHome: string, conversationId: string | null, since: string) {
    const unreadable = { completed: 0, errors: 0, since, state: "unreadable" as const };
    if (!conversationId) return unreadable;
    const path = this.io.findRollout(codexHome, conversationId);
    const text = path ? this.io.readRolloutTail(path) : null;
    if (text === null) return unreadable;
    const sinceMs = Date.parse(since);
    let completed = 0;
    let errors = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: { timestamp?: string; type?: string; payload?: { type?: string } };
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry.timestamp || !(Date.parse(entry.timestamp) > sinceMs)) continue;
      // Only the event kind and time are read; message and tool content are not.
      if (entry.type === "response_item" && /_call_output$/.test(entry.payload?.type ?? "")) completed += 1;
      if (entry.type === "event_msg" && entry.payload?.type === "error") errors += 1;
    }
    return { completed, errors, since, state: completed > 0 ? "observed" as const : "not_observed" as const };
  }

  /**
   * Account evidence counts only when the line was produced after the restart. A cursor position can't show
   * that (a TUI rewrites rows above and below the cursor), so this compares occurrences after an anchor: the
   * last history lines when the restart finished, which no redraw changes once they've scrolled up. Only text
   * after the anchor's last occurrence is compared, and a line is new only when the same text occurs there more
   * often than it did after the anchor's own position then. tmux trims the oldest history first, so trimming
   * can't remove the restart-time lines after the anchor while keeping the anchor, and older copies of a line no
   * longer hide a new one. Text that moved, stayed or was redrawn never counts more than once; anything that
   * can't be compared is not observed.
   */
  private async readAccountLine(pane: string, atRestart: { anchor: string[] | null; counts: Record<string, number> } | null, expectAccount: string | null): Promise<{ state: "matched" | "not_matched" | "not_requested" | "not_observed"; detail: string }> {
    if (!expectAccount?.trim()) return { state: "not_requested", detail: "No --expect-account given, so no account-specific evidence was checked." };
    if (atRestart === null) return { state: "not_observed", detail: "The pane's text at the restart was not recorded, so a line produced since can't be told apart from earlier text." };
    const text = await this.deps.tmux.capturePaneHistory(pane).catch(() => null);
    if (text === null) return { state: "not_observed", detail: "The pane's text could not be read." };
    const compared = atRestart.anchor === null ? text : linesAfterAnchor(paneLines(text), atRestart.anchor).join("\n");
    const seen = new Map<string, number>();
    let newest: string | undefined;
    for (const line of accountLines(compared)) {
      const key = lineDigest(line);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > (atRestart.counts[key] ?? 0)) newest = line;
    }
    if (!newest) return { state: "not_observed", detail: "No Codex status Account line was produced since the restart (lines already in the pane then don't count); show /status in the seat first." };
    return accountLineNames(newest, expectAccount)
      ? { state: "matched", detail: "An Account line produced since the restart names the expected account." }
      : { state: "not_matched", detail: "The newest Account line produced since the restart does not name the expected account (it may show only a plan)." };
  }

  private persist(event: RigEvent): void {
    let persisted: PersistedEvent | null = null;
    this.deps.db.transaction(() => {
      persisted = this.deps.eventBus.persistWithinTransaction(event);
    })();
    if (persisted) this.deps.eventBus.notifySubscribers(persisted);
  }
}

// -- helpers --

function readResumeToken(db: BetterSqlite3.Database, sessionId: string): string | null {
  const row = db.prepare("SELECT resume_token, resume_type FROM sessions WHERE id = ?").get(sessionId) as
    | { resume_token: string | null; resume_type: string | null } | undefined;
  const token = row?.resume_token?.trim();
  return token && (row?.resume_type == null || row.resume_type === "codex_id") ? token : null;
}

function executableBase(row: NativeProcessRow): string {
  const name = row.executableName ?? processArgv(row.command)[0] ?? "";
  return (name.split("/").pop() ?? name).replace(/^-/, "");
}

/** The shells `/bin/sh` can run as. macOS's /bin/sh is a shim that runs bash (or dash or zsh, if so
 *  configured), so the OS names the staged script's process after that shell, not sh. */
const SH_RUNS_AS = new Set(["sh", "bash", "dash", "zsh"]);

/** `/bin/sh <path>` running a launch script that OpenRig's tmux adapter staged, and nothing else. */
function isStagedLaunchScript(row: NativeProcessRow): boolean {
  const argv = processArgv(row.command);
  return SH_RUNS_AS.has(executableBase(row)) && argv.length === 2 && /^(?:\/bin\/)?sh$/.test(argv[0]!) && isStagedSendScriptPath(argv[1]!);
}

/** The Codex process and its Codex launcher ancestors, deepest first, up to the pane root. */
function codexChain(rows: NativeProcessRow[], deepest: NativeProcessRow, panePid: number): NativeProcessRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const chain = [deepest];
  let current = deepest;
  while (current.pid !== panePid) {
    const parent = byPid.get(current.ppid);
    if (!parent) break;
    const name = executableBase(parent);
    // A Codex launcher above the native binary: codex itself, or node running Codex's launcher script.
    const launcher = /^codex/i.test(name) || (name === "node" && processArgv(parent.command).some((arg) => /codex/i.test(arg)));
    if (!launcher) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/** The native decision each named Codex startup gate is waiting for, in plain words. OpenRig never makes it: the
 *  step names it and leaves it to the person or an authorised operator. Gates not listed keep the generic step. An
 *  update screen is a decision only when it offered a choice; otherwise it's an update screen to check (see below). */
const STARTUP_GATE_STEPS: Record<string, string> = {
  hook_trust_gate: "Codex is waiting for a hook review decision",
  trust_gate: "Codex is waiting for a folder trust decision",
  model_selection_gate: "Codex is waiting for a model choice",
  update_gate: "Codex is waiting for an update decision OpenRig could not skip",
};

/** The remaining step for a named startup gate, or null for the generic step. It states only what the launch result
 *  carries: the gate, whether an update screen offered a choice, and what the resume verification typed. */
/** Whether the resume check itself typed the update prompt's skip key (sent, or tried and failed). */
function keyTyped(launch: Extract<HarnessLaunchResult, { ok: false }>): boolean {
  return launch.verifierInput === "update_skip_key_sent" || launch.verifierInput === "update_skip_key_failed";
}

/** What the resume check typed, exactly as the launch result says, and that nothing was retried. */
function typedSentence(launch: Extract<HarnessLaunchResult, { ok: false }>): string {
  return launch.verifierInput === "update_skip_key_sent"
    ? "OpenRig sent the update prompt's skip key (3) once while checking the resume; nothing was retried or relaunched."
    : launch.verifierInput === "update_skip_key_failed"
      ? "OpenRig tried to send the update prompt's skip key (3) once and the send failed, so its effect is unknown; nothing was retried or relaunched."
      : launch.verifierInput === "none"
        ? "OpenRig typed nothing into this screen; nothing was retried or relaunched."
        : "Nothing was retried or relaunched.";
}

function startupGateStep(launch: Extract<HarnessLaunchResult, { ok: false }>, session: string, pane: string,
  recoveryCommand: string | undefined): string | null {
  const gate = launch.gate;
  if (!gate || STARTUP_GATE_STEPS[gate] === undefined) return null;
  const where = `in the pane (${session}, pane ${pane}); see it with \`rig capture ${session}\``;
  const run = `run the recovery command${recoveryCommand ? `: ${recoveryCommand}` : ""}`;
  const typed = typedSentence(launch);
  if (gate === "update_gate" && launch.screenBeforeInput && launch.verifierInput !== undefined && launch.verifierInput !== "none") {
    const before = launch.verifierInput === "update_skip_key_sent"
      ? "before it sent the update prompt's skip key (3), offered an update choice. What Codex showed after the key wasn't observed."
      : "before it tried to send the update prompt's skip key (3), offered an update choice. The send failed, so the key's effect is unknown.";
    return `The last screen OpenRig saw, ${before} See it with \`rig capture ${session}\` (pane ${pane}), then ${run}. Nothing was retried or relaunched.`;
  }
  if (gate === "update_gate" && launch.gateChoice !== true) {
    return `Codex is showing an update screen ${where}. Check it before you ${run}. ${typed}`;
  }
  return `${STARTUP_GATE_STEPS[gate]} ${where}. That decision is for the person or an authorised operator; once it's made, ${run}. ${typed}`;
}

/** Processes under the Codex process, other than Codex itself. Reported, never refused. */
function descendants(rows: NativeProcessRow[], codexPid: number, chain: NativeProcessRow[]): NativeProcessRow[] {
  const own = new Set(chain.map((row) => row.pid));
  const byParent = new Map<number, NativeProcessRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row); else byParent.set(row.ppid, [row]);
  }
  const found: NativeProcessRow[] = [];
  const queue = [...(byParent.get(codexPid) ?? [])];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const row = queue.shift()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    if (!own.has(row.pid)) found.push(row);
    queue.push(...(byParent.get(row.pid) ?? []));
  }
  return found;
}

const VALUE_OPTIONS: Record<string, keyof Omit<EffectiveSettings, "bypass" | "config"> | "config" | null> = {
  "-m": "model", "--model": "model", "-p": "profile", "--profile": "profile", "-s": "sandbox", "--sandbox": "sandbox",
  "-a": "approval", "--ask-for-approval": "approval", "-c": "config", "--config": "config",
  "-C": null, "--cd": null, "--add-dir": null, "-i": null, "--image": null,
};

/** The launch choices a running Codex's argv records, reused so the relaunch keeps them without probing. */
function runningLaunch(argv: string[]): RunningCodexLaunch {
  const addDirs: string[] = [];
  const configs: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--add-dir" && argv[index + 1] !== undefined) addDirs.push(argv[++index]!);
    else if ((arg === "-c" || arg === "--config") && argv[index + 1] !== undefined) configs.push(argv[++index]!);
    else if (arg.startsWith("--config=")) configs.push(arg.slice("--config=".length));
  }
  return { networkOverride: configs.includes(CODEX_NETWORK_DEFAULT_OVERRIDE), daemonOptOut: argv.includes("--no-daemon"), addDirs };
}

/** The settings a Codex command line runs with. cwd, add-dirs, images and the resume target are not settings. */
export function parseEffectiveSettings(argv: string[]): EffectiveSettings {
  const settings: EffectiveSettings = { model: null, profile: null, sandbox: null, approval: null, bypass: false, config: [] };
  for (let index = 1; index < argv.length; index += 1) {
    let arg = argv[index]!;
    let value: string | undefined;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eq > 0) { value = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    if (arg === "--dangerously-bypass-approvals-and-sandbox" || arg === "--yolo") { settings.bypass = true; continue; }
    if (arg === "--full-auto") { settings.sandbox ??= "workspace-write"; settings.approval ??= "on-request"; continue; }
    const key = Object.hasOwn(VALUE_OPTIONS, arg) ? VALUE_OPTIONS[arg] : undefined;
    if (key === undefined) continue;
    if (value === undefined) { value = argv[index + 1]; index += 1; }
    if (key === null || value === undefined) continue;
    if (key === "config") settings.config.push(value);
    else settings[key] = value;
  }
  settings.config.sort();
  return settings;
}

/** Which settings differ. Config overrides are named by key only; their values may be paths. */
function settingsDrift(running: EffectiveSettings, relaunch: EffectiveSettings): string[] {
  const differs: string[] = [];
  for (const key of ["model", "profile", "sandbox", "approval"] as const) if (running[key] !== relaunch[key]) differs.push(key);
  if (running.bypass !== relaunch.bypass) differs.push("approval/sandbox bypass");
  const configKey = (entry: string) => entry.split("=")[0]!;
  const a = new Set(running.config);
  const b = new Set(relaunch.config);
  const keys = new Set([...running.config.filter((entry) => !b.has(entry)), ...relaunch.config.filter((entry) => !a.has(entry))].map(configKey));
  for (const key of [...keys].sort()) differs.push(key === "model_reasoning_effort" ? "effort" : `config ${key}`);
  return differs;
}

/** Split a POSIX command line built with shellQuote (single quotes, double quotes, backslashes). */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let has = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      current += command.slice(i + 1, end < 0 ? command.length : end);
      i = end < 0 ? command.length : end;
      has = true;
    } else if (char === '"') {
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) i += 1;
        current += command[i];
        i += 1;
      }
      has = true;
    } else if (char === "\\" && i + 1 < command.length) {
      current += command[i + 1];
      i += 1;
      has = true;
    } else if (/\s/.test(char)) {
      if (has) words.push(current);
      current = "";
      has = false;
    } else {
      current += char;
      has = true;
    }
  }
  if (has) words.push(current);
  return words;
}

/** A NAME=value assignment in a launch wrapper (`env NAME=…` or `/usr/bin/env 'NAME=…'`), before the command. */
function envAssignment(command: string, name: string): string | null {
  for (const word of shellWords(command)) {
    if (word.startsWith(`${name}=`)) return word.slice(name.length + 1);
    if (/^codex$|\/codex$/.test(word)) break;
  }
  return null;
}

/** The pane's status `Account:` lines, trimmed of frame borders, in order. */
function accountLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/^[\s│|]+|[\s│|]+$/g, "")).filter((line) => /^Account:\s*\S/i.test(line));
}

/** A line's key in the recorded anchor and counts: a digest, so the event log holds no pane text or account names. */
function lineDigest(line: string): string {
  return createHash("sha256").update(line).digest("hex").slice(0, 16);
}

/** How many history lines the anchor holds. */
const ANCHOR_LINES = 8;

/** Where the pane's text stood at the restart: digests of the last history lines (the anchor) and how often each
 *  Account line occurs after them. */
export interface AccountTextMark {
  anchor: string[];
  counts: Record<string, number>;
}

/** The pane's non-empty lines, trailing blanks removed. */
function paneLines(text: string): string[] {
  return text.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

/** The lines after the anchor's last occurrence. When trimming has cut into the anchor, its longest surviving end
 *  is used; when none of it survives, every line left came after it. The last occurrence is taken, so a repeat of
 *  the anchor can only shorten what is compared, never reach back before the restart. */
export function linesAfterAnchor(lines: string[], anchor: string[]): string[] {
  const keys = lines.map(lineDigest);
  for (let size = anchor.length; size >= 1; size--) {
    const tail = anchor.slice(anchor.length - size);
    for (let at = keys.length - size; at >= 0; at--) {
      if (tail.every((key, offset) => keys[at + offset] === key)) return lines.slice(at + size);
    }
  }
  return lines;
}

/** The anchor and the Account counts after it from one capture; null when the pane couldn't be read. The last history
 *  line isn't part of the anchor: it can be the start of a line that wraps onto the screen, and joins its continuation
 *  once it scrolls up. The counts start where the anchor actually ends, not after its last match: a copy of the anchor
 *  on the screen can be redrawn away, and verify would then compare lines that were never counted. */
export function accountTextMark(capture: { history: string; all: string } | null): AccountTextMark | null {
  if (capture === null) return null;
  const history = paneLines(capture.history);
  const all = paneLines(capture.all);
  const end = Math.max(0, history.length - 1);
  const anchor = history.slice(Math.max(0, end - ANCHOR_LINES), end).map(lineDigest);
  // The two captures can be separate tmux commands. If the pane moved between them, the anchor isn't where history
  // ended, so the baseline is the whole pane with no anchor, and verify compares the whole pane.
  const aligned = anchor.every((key, i) => lineDigest(all[end - anchor.length + i] ?? "") === key);
  const counts: Record<string, number> = {};
  for (const line of accountLines((aligned ? all.slice(end) : all).join("\n"))) {
    counts[lineDigest(line)] = (counts[lineDigest(line)] ?? 0) + 1;
  }
  return { anchor: aligned ? anchor : [], counts };
}

/** Whether a status `Account:` line names `expected` as a whole value: `bob@corp.com` doesn't match
 *  `jimbob@corp.com` or `bob@corp.com.au`. Case-insensitive, as account names are. */
export function accountLineNames(line: string, expected: string): boolean {
  const want = expected.trim();
  if (!want) return false;
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9._%+@-])${escaped}($|[^A-Za-z0-9._%+@-])`, "i").test(line.replace(/^Account:\s*/i, " "));
}

export function defaultInPlaceRestartIo(): InPlaceRestartIo {
  return {
    async readProcess(pid) {
      try {
        const environ = fs.readFileSync(`/proc/${pid}/environ`);
        const env: ProcessFacts["env"] = {};
        for (const entry of environ.toString("utf8").split("\0")) {
          const eq = entry.indexOf("=");
          if (eq <= 0) continue;
          const key = entry.slice(0, eq);
          if (key === "CODEX_HOME" || key === "HOME") env[key] = entry.slice(eq + 1);
        }
        const read = (link: string) => { try { return fs.readlinkSync(`/proc/${pid}/${link}`); } catch { return null; } };
        return { cwd: read("cwd"), exe: read("exe"), env };
      } catch {
        return null;
      }
    },
    async readThreadId(pid, startedAt, codexHome) {
      return (await new CodexThreadIdResolver({ codexHome }).resolveWithReadability(pid, startedAt)).thread;
    },
    async readThreadEvidence(pid, startedAt, codexHome) {
      return new CodexThreadIdResolver({ codexHome }).resolveWithReadability(pid, startedAt);
    },
    readCredentialStore(codexHome) {
      let text: string;
      try { text = fs.readFileSync(nodePath.join(codexHome, "config.toml"), "utf8"); } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
      }
      for (const line of text.split("\n")) {
        if (/^\s*\[/.test(line)) break; // top-level keys only
        const match = line.match(/^\s*cli_auth_credentials_store\s*=\s*["']([^"']*)["']/);
        if (match) return match[1]!;
      }
      return null;
    },
    statAuthFile(codexHome) {
      try { return { mtimeMs: fs.statSync(nodePath.join(codexHome, "auth.json")).mtimeMs }; } catch { return null; }
    },
    findRollout(codexHome, conversationId) {
      for (const dbPath of resolveCodexDbPaths("", "state", undefined, codexHome)) {
        try {
          const db = new Database(dbPath, { readonly: true });
          try {
            const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(conversationId) as { rollout_path: string | null } | undefined;
            if (row?.rollout_path) return row.rollout_path;
          } finally { db.close(); }
        } catch { /* no native state in this file */ }
      }
      return null;
    },
    readRolloutTail(path) {
      const maxBytes = 4 * 1024 * 1024;
      try {
        const fd = fs.openSync(path, "r");
        try {
          const size = fs.fstatSync(fd).size;
          const start = Math.max(0, size - maxBytes);
          const buffer = Buffer.alloc(size - start);
          fs.readSync(fd, buffer, 0, buffer.length, start);
          const text = buffer.toString("utf8");
          return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
        } finally { fs.closeSync(fd); }
      } catch {
        return null;
      }
    },
  };
}
