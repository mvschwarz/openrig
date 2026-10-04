import { randomUUID } from "node:crypto";
import { inspectStartupStagedText, startupSubmissionEvidence, type StartupSubmissionEvidence } from "./startup-submission-evidence.js";
export { inspectStartupStagedText } from "./startup-submission-evidence.js";
import { OutboxHandler } from "./outbox-handler.js";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import type { EventBus } from "./event-bus.js";
import type { AgentActivity } from "./types.js";
import { wrapPaneEnvelope, appendDeliveredSegment, type EnvelopeScope } from "../lib/pane-envelope.js";
import { getSelfHostId } from "./hosts/fanout-contract.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { isShellForeground } from "./shell-classifier.js";
import { observeClaudeDelivery, verifyCodexPaneProcess, type ClaudeDeliveryObservation, type NativeProcessLister } from "./native-process-lineage.js";
import type { SlowOperationInstrumentation } from "./slow-op-recorder.js";
import { hashSentText, type CaptureObserverSink, type CaptureSlot, type ObservationInput, type ObservedBinding } from "./capture-observer.js";

// OPR.0.4.1.10 — send-readiness freshness. The runtime-hook store keeps a 5min freshness for activity
// DISPLAY, but "safe to send NOW" needs a tight window: a stale "idle" read must not authorize a send
// into what may since have become a prompt. Beyond this window the hook is ignored for send-readiness
// and we fall through to the real-time capture-pane probe. Founder-tunable later.
// Value (15s) is research-shaped, not a prior: terminal-state currency in comparable agent tooling is
// SECONDS-scale — agtx caches pane status with a ~2s TTL, and the SWE-agent/OpenDevin-derived heuristics
// (daintree #3938) cite Claude 1-3s / Codex 3-5s inter-tool-call gaps with a 6s idle debounce. A 15s
// window comfortably spans one inter-tool gap (so a mid-turn reading stays trusted) while refusing to
// authorize a send from a reading tens of seconds old. (EXA: agtx#14, daintree#3938.)
const SEND_READINESS_FRESHNESS_MS = 15_000;

// Mid-work detection patterns (cheap heuristics)
const MID_WORK_PATTERNS = [
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, // spinner chars
  /Working/,
  /^[✶✢✳✻✽·]\s+\S.*(?:…|\.{3})\s+\([^)]*\bthinking\)$/m,
  /esc to interrupt/,
  /^[❯›]\s*\d+\.\s/m,   // trust/consent prompt choices (e.g. '› 1. Yes, continue')
];

// Idle-prompt patterns: empty prompt line (no typed text after the char).
// Lines like '❯ Working on a task.' have text after the prompt char and
// are NOT idle — the prompt is active with input that may look mid-work.
// Codex 0.157 renders a fixed placeholder in the empty composer (codex-rs/tui/src/chatwidget.rs
// `PLACEHOLDER`) and its footer no longer carries the `· Context [` status bar. The placeholder
// is visible both idle and mid-turn; mid-turn the status row (`Working … esc to interrupt`)
// normally sits above it, but Codex hides that row while it streams assistant output. So the
// placeholder counts as idle only through MID_WORK_PATTERNS here, and classifySendReadiness
// never lets a placeholder-only verdict override a display-fresh running/needs_input hook.
const CODEX_EMPTY_COMPOSER_PATTERN = /^›\s+Ask Codex to do anything\s*$/;

// Codex's live turn-status row: a bullet, a header ("Working", or the reasoning summary Codex shows in its place),
// then the elapsed time and "esc to interrupt" in parentheses, e.g. "• Working (1h 09m 39s • esc to interrupt)".
// Completed output that merely says "Working directory: …" or "Working tree is clean." never matches.
const CODEX_TURN_STATUS_PATTERN = /^[•◦]\s+\S.*\((?:\d+[hms]\s*)+•\s*esc to interrupt\)/;

const IDLE_PROMPT_PATTERNS = [
  /^[❯›]\s*$/,  // prompt char + optional whitespace + end-of-line only
  CODEX_EMPTY_COMPOSER_PATTERN,
];

const PROMPT_DRAFT_PATTERNS = [
  /^[❯›]\s+\S/,
];

// Footer hints, not proof of inactivity: Claude also renders its mode bar
// during a turn. Current live-status evidence must take precedence below.
const IDLE_STATUS_BAR_PATTERNS = [
  /gpt-\d[\d.]* .+ · Context \[/,  // Codex model/context footer
  /⏵⏵ accept edits/,              // Claude Code edit-accept bar
];

const IDLE_TERMINAL_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "nu", "tmux"]);

// OPR.0.4.1.10 — permission / confirmation question signatures. The numbered-selector pattern
// (`❯/› N.`) already catches the highlighted AskUserQuestion / trust-prompt choice; these catch the
// permission QUESTION line itself so a permission block whose selector has scrolled above an idle-
// looking footer is still classified as needing input (not idle). Specific phrasings keep the
// false-positive rate near zero (an agent rarely prints "Do you want to proceed?" as plain output).
const PERMISSION_PROMPT_PATTERNS = [
  /\bDo you want to (?:proceed|continue|trust|allow|make|apply|create|run|delete|overwrite|edit)\b/i,
  /\bDo you trust the\b/i,
  // Codex v0.139.0 command-approval render (qa-codex-approval-render-research-20260627): the selector
  // (`› N.`) is already caught above; these question lines make the fallback robust if it scrolls out.
  /\bWould you like to run the following command\b/i,
  /\bAllow Codex to run\b/i,
];

// OPR.0.4.1.10 — how many trailing non-blank lines to scan for an interactive-prompt SIGNATURE (the
// numbered selector / permission question). Wider than the generic activity window (8) because a real
// prompt's selector can be pushed UP past the bottom few lines by a tall persistent footer — Claude
// Code renders status bar + permission-mode hint + separator + input-box border + thinking-budget BELOW
// the actual "❯ " prompt, and in a narrow tiled pane that footer pushes the prompt out of an 8-line
// window, causing a false-idle read (the exact footgun). 12 mirrors the window the ntm project adopted
// after hitting this. Erring toward "prompt detected" is the SAFE direction for this guard: a false
// refusal is overridable; a false-idle lets a message land on a prompt. (EXA: ntm e28763e; AgentDeck.)
const PROMPT_SCAN_LINES = 12;

export interface PaneActivityClassification {
  state: "agent_active" | "agent_idle" | "attention" | "unknown";
  reason: string;
  evidence: string | null;
}

function trimPaneLines(paneContent: string): string[] {
  return paneContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function truncateEvidence(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function findPatternEvidence(lines: string[], patterns: RegExp[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (patterns.some((pattern) => pattern.test(line))) return truncateEvidence(line);
  }
  return null;
}

// Claude can leave these noninteractive warnings BELOW the input box and mode bar.
// Recognize the complete input block, never a warning or historical prompt alone.
const CLAUDE_STATUS_WARNINGS = [
  /^✘ Auto-update failed: no write permission to npm prefix · Run claude doctor$/,
  /^tmux focus-events off · add 'set -g focus-events on' to ~\/\.tmux\.conf and re…$/,
  /^You've used (?:\d|[1-9]\d)% of your weekly limit · resets \d{1,2}(?::\d{2})?(?:am|pm) \(UTC\)$/,
];
// Current Claude status rows need not end in "thinking)" or show "esc to interrupt".
// Completed summaries such as "✻ Crunched for 2s" lack the live ellipsis/timer shape.
const CLAUDE_LIVE_STATUS_PATTERN = /^[✶✢✳✻✽·*]\s+\S[^(]*(?:…|\.{3})\s+\((?:\d+h\s+)?(?:\d+m\s+)?\d+s\b/;

function findClaudeComposer(paneContent: string) {
  // Preserve columns: a multiline draft may contain indented border/prompt text.
  // This classifier scans at most 20 physical lines; captures can be taller.
  // Exhausting the scan without reaching the status head is unknown, not idle.
  const lines = paneContent.split("\n").slice(-20)
    .map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  let bar = lines.length - 1;
  while (bar >= 0 && CLAUDE_STATUS_WARNINGS.some((pattern) => pattern.test(lines[bar]!.trim()))) bar--;
  const supportedWarningFooter = lines[bar]?.trim() === "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents";
  const indent = /^([ \t]*)─{3,}$/.exec(lines[bar - 1] ?? "")?.[1];
  if (indent === undefined) return null;
  const upper = lines[bar - 3] ?? "";
  const prompt = lines[bar - 2] ?? "";
  if (!upper.startsWith(indent) || !/^─{3,}(?: .+ ─+)?$/.test(upper.slice(indent.length)) ||
      !prompt.startsWith(`${indent}❯`) || !/^❯(?:\s|$)/.test(prompt.slice(indent.length))) return null;

  let liveStatus: string | null = null;
  let headSeen = false;
  for (let i = bar - 4; i >= 0; i--) {
    if (!lines[i]!.startsWith(indent)) break;
    const line = lines[i]!.slice(indent.length);
    if ([CLAUDE_LIVE_STATUS_PATTERN, ...MID_WORK_PATTERNS].some((pattern) => pattern.test(line))) {
      liveStatus = truncateEvidence(line);
      headSeen = true;
      break;
    }
    // Indented task rows can follow the live status. A newer unindented output
    // or completed status ends this block; do not revive an older work row.
    if (!/^\s/.test(line)) { headSeen = true; break; }
  }
  return { text: prompt.slice(indent.length), hasWarnings: bar < lines.length - 1, supportedWarningFooter, headSeen, liveStatus };
}

function findPromptDraftBeforeFooter(paneContent: string): string | null {
  const rawLines = paneContent.split("\n").map((line) => line.trimEnd());
  let lastLineIndex = rawLines.length - 1;
  while (lastLineIndex >= 0 && rawLines[lastLineIndex]!.trim().length === 0) {
    lastLineIndex--;
  }
  if (lastLineIndex <= 0) return null;

  const footerLine = rawLines[lastLineIndex]!.trim();
  const footerIsIdle = IDLE_STATUS_BAR_PATTERNS.some((pattern) => pattern.test(footerLine));
  if (!footerIsIdle) return null;

  const priorLine = rawLines[lastLineIndex - 1]!;
  if (priorLine.trim().length === 0) return null;

  const priorTrimmed = priorLine.trim();
  const looksLikeDraft = PROMPT_DRAFT_PATTERNS.some((pattern) => pattern.test(priorTrimmed));
  const looksLikeSelection = /^[❯›]\s*\d+\.\s/.test(priorTrimmed);
  if (!looksLikeDraft || looksLikeSelection) return null;

  return truncateEvidence(priorTrimmed);
}

export function classifyPaneActivity(paneContent: string): PaneActivityClassification {
  const lastNonBlank = trimPaneLines(paneContent);
  if (lastNonBlank.length === 0) {
    return { state: "unknown", reason: "empty_capture", evidence: null };
  }

  const recentLines = lastNonBlank.slice(-8);
  // Wider window for prompt SIGNATURES so a tall footer can't push a real prompt out of view (see
  // PROMPT_SCAN_LINES). The generic activity checks below keep the tighter 8-line window.
  const promptScanLines = lastNonBlank.slice(-PROMPT_SCAN_LINES);
  const trailingNonBlank = lastNonBlank.slice(-3);
  const lastLine = lastNonBlank.at(-1) ?? "";
  const idlePromptLine = trailingNonBlank.find((line) =>
    IDLE_PROMPT_PATTERNS.some((pattern) => pattern.test(line))
  );
  const idleStatusBarLine = IDLE_STATUS_BAR_PATTERNS.some((pattern) => pattern.test(lastLine))
    ? lastLine
    : null;
  const selectionPromptEvidence = findPatternEvidence(promptScanLines, [/^[❯›]\s*\d+\.\s/m]);
  if (selectionPromptEvidence) {
    return {
      state: "attention",
      reason: "selection_prompt",
      evidence: selectionPromptEvidence,
    };
  }

  // OPR.0.4.1.10 (FR-1c): a permission/confirmation question is attention even when its selector is
  // not in view — checked before the idle short-circuits so a permission block above an idle-looking
  // footer never reads as idle (which would let a default send land on it).
  const permissionPromptEvidence = findPatternEvidence(promptScanLines, PERMISSION_PROMPT_PATTERNS);
  if (permissionPromptEvidence) {
    return {
      state: "attention",
      reason: "permission_prompt",
      evidence: permissionPromptEvidence,
    };
  }

  const claudeComposer = findClaudeComposer(paneContent);
  if (claudeComposer?.hasWarnings && claudeComposer.supportedWarningFooter && PROMPT_DRAFT_PATTERNS.some((pattern) => pattern.test(claudeComposer.text))) {
    return { state: "attention", reason: "prompt_draft", evidence: truncateEvidence(claudeComposer.text) };
  }
  if (claudeComposer?.liveStatus) {
    return { state: "agent_active", reason: "mid_work_pattern", evidence: claudeComposer.liveStatus };
  }
  if (claudeComposer && !claudeComposer.headSeen) {
    return { state: "unknown", reason: "no_activity_signal", evidence: truncateEvidence(lastLine) };
  }
  if (claudeComposer && (!claudeComposer.hasWarnings || claudeComposer.supportedWarningFooter) &&
      IDLE_PROMPT_PATTERNS.some((pattern) => pattern.test(claudeComposer.text))) {
    return { state: "agent_idle", reason: idleStatusBarLine ? "idle_status_bar" : "idle_prompt",
      evidence: truncateEvidence(idleStatusBarLine ?? claudeComposer.text) };
  }

  const promptDraftEvidence = findPromptDraftBeforeFooter(paneContent);
  if (promptDraftEvidence) {
    return {
      state: "attention",
      reason: "prompt_draft",
      evidence: promptDraftEvidence,
    };
  }

  const midWorkEvidence = findPatternEvidence(recentLines, [...MID_WORK_PATTERNS, CLAUDE_LIVE_STATUS_PATTERN]);
  if (idleStatusBarLine && (!idleStatusBarLine.includes("⏵⏵ accept edits") || !midWorkEvidence)) {
    return {
      state: "agent_idle",
      reason: "idle_status_bar",
      evidence: truncateEvidence(idleStatusBarLine),
    };
  }
  // Codex keeps its empty-composer placeholder on screen during a turn, and its turn-status row
  // (`• Working (… esc to interrupt)`) can sit well above the composer when queued or incoming
  // message blocks come in between. So under the placeholder, that row anywhere in the capture is
  // the turn still running. Only the status-row signature counts at that range: completed prose
  // ("Working tree is clean.") further up is history, and the 8-line generic check below still applies.
  const placeholderMidWork = idlePromptLine && CODEX_EMPTY_COMPOSER_PATTERN.test(idlePromptLine)
    ? findPatternEvidence(lastNonBlank, [CODEX_TURN_STATUS_PATTERN])
    : null;
  if (placeholderMidWork) {
    return {
      state: "agent_active",
      reason: "mid_work_pattern",
      evidence: placeholderMidWork,
    };
  }
  if (idlePromptLine && !midWorkEvidence) {
    return {
      state: "agent_idle",
      reason: "idle_prompt",
      evidence: truncateEvidence(idlePromptLine),
    };
  }

  if (midWorkEvidence) {
    return {
      state: "agent_active",
      reason: "mid_work_pattern",
      evidence: midWorkEvidence,
    };
  }

  if (idlePromptLine) {
    return {
      state: "agent_idle",
      reason: "idle_prompt",
      evidence: truncateEvidence(idlePromptLine),
    };
  }

  return {
    state: "unknown",
    reason: "no_activity_signal",
    evidence: truncateEvidence(lastLine),
  };
}

export async function probeSessionActivity(input: {
  sessionName: string | null;
  runtime: string | null;
  attachmentType: "tmux" | "external_cli" | null | undefined;
  tmuxAdapter: TmuxAdapter;
  now?: Date;
  /** S01/S02 P2: optional read-only observer of the capture this probe already takes. */
  captureObserver?: CaptureObserverSink;
  binding?: Omit<ObservedBinding, "sessionName">;
}): Promise<AgentActivity> {
  // Capture routing and observation labels must share the entry context. The
  // caller may reuse/mutate its input while hasSession is pending.
  const { sessionName, runtime, attachmentType, tmuxAdapter, now, captureObserver, binding } = input;
  const sampledAt = (now ?? new Date()).toISOString();
  // P2: attempt identity frozen at entry, before any await. Early returns below
  // take no capture and are not observed.
  const observed = captureObserver ? {
    attemptId: randomUUID(),
    binding: Object.freeze({
      sessionName: sessionName ?? "",
      nodeId: binding?.nodeId ?? null,
      occupant: binding?.occupant ?? null,
      pane: binding?.pane ?? null,
    }),
    runtime,
    sink: captureObserver,
  } : undefined;

  if (!sessionName) {
    return {
      state: "unknown",
      reason: "no_session",
      evidenceSource: "session_registry",
      sampledAt,
      evidence: null,
    };
  }
  if (attachmentType === "external_cli") {
    return {
      state: "unknown",
      reason: "unsupported_attachment",
      evidenceSource: "external_cli",
      sampledAt,
      evidence: sessionName,
    };
  }
  if (runtime === "terminal") {
    try {
      const paneCommand = await tmuxAdapter.getPaneCommand(sessionName);
      if (paneCommand && !IDLE_TERMINAL_COMMANDS.has(paneCommand)) {
        return {
          state: "running",
          reason: "foreground_command",
          evidenceSource: "pane_heuristic",
          sampledAt,
          evidence: paneCommand,
          fallback: true,
        };
      }
    } catch {
      return {
        state: "unknown",
        reason: "capture_failed",
        evidenceSource: "pane_heuristic",
        sampledAt,
        evidence: null,
        fallback: true,
      };
    }

    return {
      state: "unknown",
      reason: "unsupported_runtime",
      evidenceSource: "pane_heuristic",
      sampledAt,
      evidence: null,
      fallback: true,
    };
  }

  try {
    const exists = await tmuxAdapter.hasSession(sessionName);
    if (!exists) {
      return {
        state: "unknown",
        reason: "session_missing",
        evidenceSource: "tmux_session",
        sampledAt,
        evidence: sessionName,
      };
    }
  } catch {
    return {
      state: "unknown",
      reason: "tmux_unavailable",
      evidenceSource: "tmux_session",
      sampledAt,
      evidence: null,
    };
  }

  const observeProbe = (slot: CaptureSlot, activity: AgentActivity): AgentActivity => {
    if (observed) {
      safeRecord(observed.sink, {
        seam: "probe_activity",
        attemptId: observed.attemptId,
        binding: observed.binding,
        runtime: observed.runtime,
        sentHash: null,
        pre: slot,
        post: { state: "not_requested" },
        regexResult: { state: activity.state, reason: activity.reason },
        completedAt: new Date().toISOString(),
      });
    }
    return activity;
  };
  const captureSeq = observed ? nextCaptureSeq++ : 0;
  try {
    const paneContent = await tmuxAdapter.capturePaneContent(sessionName, 20);
    const capturedAt = new Date().toISOString();
    const classification = classifyPaneActivity(paneContent ?? "");
    return observeProbe(captureSlot(paneContent, capturedAt, captureSeq), {
      state: mapPaneState(classification.state),
      reason: classification.reason,
      evidence: classification.evidence,
      evidenceSource: "pane_heuristic",
      sampledAt,
      fallback: true,
    });
  } catch {
    return observeProbe({ state: "unavailable", cause: "capture_error", capturedAt: new Date().toISOString(), captureSeq }, {
      state: "unknown",
      reason: "capture_failed",
      evidenceSource: "pane_heuristic",
      sampledAt,
      evidence: null,
      fallback: true,
    });
  }
}

// Process-local invocation order of observed capture attempts, NOT completion
// order or a durable/global sequence. attemptId remains the cross-process join.
let nextCaptureSeq = 1;

/** capturedAt is when the capture returned/threw, not the enclosing send's completion. */
function captureSlot(content: string | null | undefined, capturedAt: string, captureSeq: number): CaptureSlot {
  return typeof content === "string"
    ? { state: "captured", content, capturedAt, captureSeq }
    : { state: "unavailable", cause: "empty_or_failed", capturedAt, captureSeq };
}

/** Copy only the verdict fields the caller actually produced; absent stays absent. */
function pickDefined(result: object, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (result as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Observation must never alter a transport result: any sink failure is swallowed here. */
function safeRecord(sink: CaptureObserverSink, input: ObservationInput): void {
  try { sink.record(input); } catch { /* observer failure never reaches the caller */ }
}

export function mapPaneState(state: PaneActivityClassification["state"]): AgentActivity["state"] {
  if (state === "agent_active") return "running";
  if (state === "attention") return "needs_input";
  if (state === "agent_idle") return "idle";
  return "unknown";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    count++;
    start = index + needle.length;
  }
  return count;
}

/** Map a resolved fan-out target + its recipient list → the EnvelopeScope (ruling 03c35295). The
 *  transport knows the target shape + resolved seats, so it builds the honest scale daemon-side:
 *  DM / multi (full list) / rig- or pod-scoped broadcast (with seat count) / topology. */
export function scopeForTarget(target: TargetSpec, recipients: string[]): EnvelopeScope {
  if ("session" in target) return { kind: "dm" };
  if ("sessions" in target) return { kind: "multi", recipients };
  if ("rig" in target && !("pod" in target)) return { kind: "rig-broadcast", rig: target.rig, seats: recipients.length };
  if ("pod" in target) return { kind: "rig-broadcast", rig: target.rig ? `${target.rig}/${target.pod}` : target.pod, seats: recipients.length };
  return { kind: "topology" }; // { global: true }
}

export type TargetSpec =
  | { session: string }
  // OPR.0.4.3.30 — explicit multi-recipient list (`rig send --to a,b`). Resolved via
  // resolveByList (each name through the single-name resolver, so ambiguity/not-found are
  // reported honestly against the exact seat).
  | { sessions: string[] }
  | { rig: string }
  | { pod: string; rig?: string }
  | { global: true };

export type ResolveResult =
  | { ok: true; sessions: Array<{ sessionName: string; rigName: string; nodeLogicalId: string }> }
  | { ok: false; code: "not_found" | "ambiguous"; error: string };

/** The existing submit-only identity check, also used to inspect startup's own paste.
 * A false result is no matching staged evidence, not proof of model consumption. */
export function hasExpectedStagedText(pane: string | null, expected: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, "");
  // Round-2 (r2 HIGH-1): the evidence must be the CURRENT ACTIVE INPUT and must identify
  // THIS piece — stale scrollback can carry an old placeholder while a LATER interactive
  // prompt owns the input, and an Enter there approves the prompt. So:
  //   1. Only the pane's LAST input-marker line counts (the current input; everything above
  //      is history).
  //   2. A numbered-option line (`❯ 1. …`) is a PROMPT SELECTION, never staged input: refuse.
  //   3. A pasted-text placeholder is identity-qualified: "[Pasted text #N +X lines]" counts
  //      only when X matches the expected piece's own line count (±1 for a trailing newline).
  //      More than one placeholder is COALESCED staging (several pieces, one Enter): refuse.
  //   4. Otherwise the line must carry the content's own head (24 normalized chars — a short
  //      paste renders inline, possibly truncated).
  const paneLines = (pane ?? "").split("\n");
  let currentInputAt = -1;
  for (let i = paneLines.length - 1; i >= 0; i--) {
    if (paneLines[i]!.trimStart().startsWith("❯")) { currentInputAt = i; break; }
  }
  let stagedEvidence = false;
  if (currentInputAt >= 0) {
    const inputLine = paneLines[currentInputAt]!.trimStart();
    // The region is the last ❯-line through the input box's closing separator (a box-drawing
    // line) or pane end — wrapped input continues below the marker; everything ABOVE the
    // marker is history and everything below the separator is hint-bar chrome.
    let regionEnd = paneLines.length;
    for (let i = currentInputAt + 1; i < paneLines.length; i++) {
      const t = paneLines[i]!.trim();
      if (t.length >= 10 && /^[─═-]+$/.test(t)) { regionEnd = i; break; }
    }
    const region = paneLines.slice(currentInputAt, regionEnd).join("\n");
    if (!/^❯\s*\d+\./.test(inputLine)) {
      // Round-3 (r2 R2 HIGH-1, specimen-pinned): Claude renders ONE staged piece as MANY
      // placeholders whose displayed counts are SEGMENT sizes (sum ≤ source lines), followed
      // by the piece's own literal tail wrapped across pane lines — and the placeholder
      // tokens themselves wrap. So: collapse wrapping, then
      //   IDENTITY  — the literal residual (region minus tokens minus hint chrome) must be a
      //               CONTIGUOUS substring of the piece: the visible words are the piece's
      //               words. Foreign residual (another piece, stale content) refuses.
      //   SANITY    — the segment-count sum must not exceed the piece's own line count
      //               (small slack), and with NO residual anchor must reach at least 60% of
      //               it — a bare unrelated placeholder cannot masquerade as this piece.
      const placeholderRe = /\[Pasted text #\d+ \+(\d+) lines\]/g;
      const regionFlat = region.replace(/\s+/g, " ");
      const counts = [...regionFlat.matchAll(placeholderRe)].map((m) => Number(m[1]));
      if (counts.length === 0) {
        const head = norm(expected).slice(0, 24);
        stagedEvidence = head.length > 0 && norm(region).includes(head);
      } else {
        // Round-4 (r2 R3 HIGH-1): identity is the rendering's own structure, specimen-proven —
        // the placeholders are the piece's HEAD chunks and the literal residual is the piece's
        // normalized SUFFIX (524 chars in the preserved capture). Size similarity and short
        // shared phrases are NOT identity: with no residual, or one under 48 normalized chars,
        // or one that is not the piece's own suffix, FAIL CLOSED — the TUI did not expose
        // enough content to identify the staged state, and a bare Enter is never guessed.
        const chrome = /paste again to expand|ctrl\+g to edit( in Vim)?/gi;
        const residual = norm(regionFlat.replace(placeholderRe, "").replace(chrome, "")).replace(/^❯/, "");
        const pieceNorm = norm(expected);
        const sum = counts.reduce((a, b) => a + b, 0);
        // Round-5 (r2 R4 HIGH-1): the suffix anchor is JOINED to the opaque prefix. The
        // placeholder sum identifies the hidden SOURCE BOUNDARY immediately before the
        // visible suffix (specimen: sum 130 = the residual begins after exactly 130 of the
        // piece's 142 source newlines). Compute the boundary from the piece bytes — the
        // number of leading source lines whose normalized text the residual does NOT cover —
        // and require the sum to EQUAL it exactly (round-6, r2 R5: both separately staged
        // preserved pieces are exact — 130=130 and 82=82; a tolerance was unsupported by the
        // renderer evidence). A matched suffix with a non-matching sum is a truncated or
        // wrong prefix: refuse.
        let boundary = -1;
        if (residual.length >= 48 && pieceNorm.endsWith(residual)) {
          const srcLines = expected.split("\n");
          let acc = 0;
          boundary = 0;
          for (let i = srcLines.length - 1; i >= 0; i--) {
            acc += norm(srcLines[i]!).length;
            if (acc >= residual.length) { boundary = i; break; }
          }
        }
        stagedEvidence = boundary >= 0 && sum === boundary;
      }
    }
  }
  return stagedEvidence;
}

/** An interaction may consume its answer immediately. Only add Enter when the
 * complete answer is still visible in a bounded current text input, never a
 * numbered choice or a partial prefix. Unknown rendering is not consumption. */
function promptAnswerStaged(pane: string | null, answer: string, runtime: string | null): boolean {
  if (!pane || !answer.trim() || /[\r\n\x1b]/.test(answer)) return false;
  const lines = pane.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const input = lines[i]!.trimStart();
    if (!/^[❯›]/.test(input)) continue;
    if (/^[❯›]\s*\d+[.)]/.test(input)) return false;
    if (runtime === "codex" ? !input.startsWith("›") : runtime !== "claude-code" || !input.startsWith("❯")) return false;
    const end = lines.findIndex((line, index) => index > i && (runtime === "codex"
      ? line.trim() === "" : /^[─═-]{10,}$/.test(line.trim())));
    return end > i && lines.slice(i, end).join("\n").trimStart().slice(1).trim() === answer.trim();
  }
  return false;
}

export interface SendOpts {
  /** Internal managed lifecycle prerequisite; never accepted from HTTP send options. */
  beforeWrite?: () => void;
  /** Stable caller request ID, reused for readback after transport uncertainty. */
  deliveryId?: string;
  auditPointer?: string;
  /** Internal queue seam: already committed original members, never client-supplied. */
  committedOutboxIds?: string[];
  verify?: boolean;
  force?: boolean;
  waitForIdleMs?: number;
  // OPR.0.4.1.10 — interactive-prompt / permission guard.
  // `dangerouslyInteract` is the ONLY override of the prompt/permission guard (force does NOT bypass
  // it). It requires `reason` and writes an auditable `transport.prompt_override` record before the
  // send. `actorSession` is the caller identity recorded in that audit. (`--raw` is purely a CLI-side
  // envelope concern — the daemon guard behaves identically for raw and wrapped text.)
  dangerouslyInteract?: boolean;
  reason?: string;
  actorSession?: string | null;
  // GHOST-STAGE (h): the envelope's compose stamp (ISO), threaded to send() so the WRITE-moment
  // delivered-latency calc can measure how long the message waited. Absent ⇒ no delivered segment.
  stampISO?: string;
  // Mechanics-gate fix (desk ruling d9b3989a): press Enter WITHOUT typing — the single submit
  // retry for text that was pasted but never accepted by the target TUI. Safe by construction:
  // requires `expectedStagedText`, and the pane must actually contain it before the Enter lands —
  // a bare Enter at anything else (e.g. a permission prompt) is refused as staged_mismatch. The
  // caller's `text` argument must be empty in this mode.
  submitOnly?: boolean;
  expectedStagedText?: string;
  /** Internal startup caller needs a bounded view of an expanded multiline composer. */
  submitOnlyCaptureLines?: 50 | 200;
  /** Internal startup only: require complete visible composer identity before Enter. */
  requireFullStagedText?: boolean;
  /** Internal, synchronous diagnostics sink. Exceptions never affect transport. */
  onStartupMismatch?: (evidence: StartupSubmissionEvidence) => void;
  /** Round-2 (r2 HIGH-1): the walked piece's own line count — placeholder identity. A large paste
   *  renders as "[Pasted text #N +X lines]"; X must match this count for the placeholder to count
   *  as evidence of THIS piece. */
  expectedStagedLineCount?: number;
}

// OPR.0.4.3.30 — options for the fan-out path (`broadcast()`). Superset of SendOpts.
// `envelopeSender`, when set, makes the fan-out wrap EACH recipient's text in its own
// From/To pane envelope (byte-identical to single-send CLI wrapping via wrapPaneEnvelope),
// so a multi/pod/rig `rig send` gives each seat its own `To:` header. Absent for
// `rig broadcast` (raw-to-all, unchanged) and for the CLI --raw / --dangerously-interact paths.
export interface BroadcastOpts extends SendOpts {
  envelopeSender?: string;
  // stampISO (ruling 03c35295: the transport ISO stamp, computed ONCE at send-time, injectable for
  // deterministic tests) now lives on the base SendOpts — (h) send() reads it for delivered-latency.
}

export interface SendResult {
  ok: boolean;
  sessionName: string;
  verified?: boolean;
  /** Audited prompt answer: consumers must never automatically retry Enter.
   * Neither value establishes model consumption. Absent for ordinary sends. */
  promptInteraction?: "enter-sent" | "unverified";
  /**
   * OPR.99.0.6.3 — honest delivery-outcome vocabulary (additive; `verified`
   * keeps its exact semantics for existing parsers). Three distinguishable
   * states, mirroring the restore honest-outcome style:
   * - `delivered`: text + Enter landed AND the post-send capture re-confirmed
   *   the snippet (the strong positive; was `Verified: yes`).
   * - `rendered-unconfirmed`: text + Enter BOTH succeeded (the message landed)
   *   but the post-send capture raced a TUI redraw and could not re-confirm
   *   the snippet. Landed-but-unconfirmable, NOT a failure — confirm with
   *   `rig capture` if it matters. (Was collapsed into `Verified: no`.)
   *   For a prompt answer, `promptInteraction: "unverified"` means input was
   *   sent without added Enter; the prompt may already have consumed it.
   * - `failed`: the transport itself failed (paste or Enter did not land) —
   *   set on the send_failed / submit_failed returns for vocabulary symmetry;
   *   their `ok:false` + HTTP mapping is unchanged.
   */
  outcome?: "delivered" | "rendered-unconfirmed" | "failed" | "retained";
  outboxIds?: string[];
  warning?: string;
  error?: string;
  reason?: string;
  /** Set on the submit-only (bare Enter) mode's success — no text was typed. */
  submitOnly?: boolean;
  activity?: AgentActivity;
  waitedMs?: number;
  attempts?: number;
  sent?: boolean;
}

export interface CaptureResult {
  ok: boolean;
  sessionName: string;
  content?: string;
  lines?: number;
  error?: string;
  reason?: string;
}

export interface BroadcastResult {
  total: number;
  sent: number;
  retained?: number;
  failed: number;
  results: SendResult[];
}

interface SessionTransportDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  tmuxAdapter: TmuxAdapter;
  agentActivityStore?: AgentActivityStore;
  // OPR.0.4.1.10 — required only for the --dangerously-interact audit path. When absent, a dangerous
  // override fails closed (refuses) rather than sending unaudited. Non-danger sends never need it.
  eventBus?: EventBus;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  waitForIdlePollMs?: number;
  // OPR.0.4.1.10 — send-readiness freshness override (default SEND_READINESS_FRESHNESS_MS). Test seam.
  sendReadinessFreshnessMs?: number;
  slowOpRecorder?: SlowOperationInstrumentation;
  activityEndpointFile?: () => { baseUrl: string; token: string } | null;
  /** S01/S02 P2: optional read-only capture observer. Absent by default (no activation). */
  captureObserver?: CaptureObserverSink;
  listProcesses?: NativeProcessLister;
}

interface SessionRow { node_id: string; session_name: string; }
interface NodeRow { rig_id: string; logical_id: string; }
interface SessionMetaRow { runtime: string | null; attachment_type: string | null; node_id: string | null; binding_session: string | null; pane: string | null; occupant: string | null; resume_token: string | null; }
interface ResolvedTarget { sessionName: string; rigName: string; nodeLogicalId: string; }

export class SessionTransport {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private tmuxAdapter: TmuxAdapter;
  private agentActivityStore?: AgentActivityStore;
  private eventBus?: EventBus;
  private now: () => Date;
  private sleep: (ms: number) => Promise<void>;
  private waitForIdlePollMs: number;
  private sendReadinessFreshnessMs: number;
  private slowOpRecorder?: SlowOperationInstrumentation;
  private activityEndpointFile: () => { baseUrl: string; token: string } | null;
  private captureObserver?: CaptureObserverSink;
  private listProcesses?: NativeProcessLister;

  constructor(deps: SessionTransportDeps) {
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.agentActivityStore = deps.agentActivityStore;
    this.eventBus = deps.eventBus;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? delay;
    this.waitForIdlePollMs = deps.waitForIdlePollMs ?? 500;
    this.sendReadinessFreshnessMs = deps.sendReadinessFreshnessMs ?? SEND_READINESS_FRESHNESS_MS;
    this.slowOpRecorder = deps.slowOpRecorder;
    this.activityEndpointFile = deps.activityEndpointFile ?? (() => null);
    this.captureObserver = deps.captureObserver;
    this.listProcesses = deps.listProcesses;
  }

  /**
   * Slice-05 D5/D6 — when a live transport op (send/capture) observes that the
   * seat's tmux session is genuinely gone (a `probeSession` result of `absent`
   * — POSITIVE tmux evidence, never a transport failure; OPR.0.5.4.2 mini-req
   * 5), durably record the SAME `session_missing` identity verdict the
   * reconciler would write, so `rig ps` stops reporting the dead seat as
   * running WITHOUT waiting for the next reconciler poll. This is the
   * transport-side writer of the shared verdict bridge; the reconciler is the
   * poll-side writer. Transport-absence must never reach this method: a blip
   * against a live seat would otherwise fabricate a durable absence verdict.
   *
   * Only writes an APPLICABLE verdict: the join is narrowed to the node whose
   * LATEST running session_name equals the probed session (so
   * `verdict.sessionName === latest session_name`, the node-inventory
   * applicability gate), and it only writes when a binding pane is registered
   * (a null pane is the reconciler's `tmux_unavailable` case, which is
   * non-down-ranking — never fabricate `session_missing` without a pane).
   * Never mutates `sessions.status`.
   */
  private recordSessionMissingVerdict(sessionName: string): void {
    const seat = this.db
      .prepare(`
        SELECT n.id AS node_id, s.session_name AS session_name, b.tmux_pane AS tmux_pane
        FROM nodes n
        JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        LEFT JOIN bindings b ON b.node_id = n.id
        WHERE s.status = 'running'
          AND s.session_name = ?
        LIMIT 1
      `)
      .get(sessionName) as { node_id: string; session_name: string; tmux_pane: string | null } | undefined;
    if (!seat || seat.tmux_pane === null) return;
    new SeatIdentityStore(this.db).upsert({
      nodeId: seat.node_id,
      verdict: "pane_missing",
      evidenceSource: "tmux_session",
      reason: "session_missing",
      evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: seat.session_name,
      observedAt: this.now().toISOString(),
    });
  }

  private getSessionMeta(sessionName: string): {
    runtime: string | null; attachmentType: string | null; nodeId: string | null; pane: string | null; occupant: string | null; resumeToken: string | null;
  } {
    // One existing statement; P2 reads the binding columns it already joins plus the
    // same current-occupant subselect the delivery guard uses. No extra query.
    const row = this.db.prepare(`
      SELECT
        n.runtime AS runtime,
        b.attachment_type AS attachment_type,
        n.id AS node_id,
        b.tmux_session AS binding_session,
        b.tmux_pane AS pane,
        s.resume_token AS resume_token,
        (SELECT generation_uuid FROM occupant_tenures t WHERE t.node_id = n.id ORDER BY generation_ordinal DESC LIMIT 1) AS occupant
      FROM sessions s
      JOIN nodes n ON s.node_id = n.id
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE s.session_name = ?
      ORDER BY s.id DESC
      LIMIT 1
    `).get(sessionName) as SessionMetaRow | undefined;

    return {
      runtime: row?.runtime ?? null,
      attachmentType: row?.attachment_type ?? null,
      nodeId: row?.node_id ?? null,
      // The row may be a historical session of a node now bound elsewhere: only a
      // binding whose session IS this name labels pane/occupant; otherwise unknown.
      pane: row?.binding_session === sessionName ? row?.pane ?? null : null,
      occupant: row?.binding_session === sessionName ? row?.occupant ?? null : null,
      resumeToken: row?.resume_token ?? null,
    };
  }

  async resolveSessions(target: TargetSpec): Promise<ResolveResult> {
    if ("session" in target) {
      return this.resolveBySessionName(target.session);
    }
    if ("sessions" in target) {
      return this.resolveByList(target.sessions);
    }
    if ("pod" in target) {
      return this.resolveByPod(target.pod, target.rig);
    }
    if ("global" in target) {
      return this.resolveGlobal();
    }
    return this.resolveByRig(target.rig);
  }

  private resolveGlobal(): ResolveResult {
    const allRigs = this.rigRepo.listRigs();
    if (allRigs.length === 0) {
      return { ok: false, code: "not_found", error: "No rigs found. Check status with: rig ps" };
    }
    const sessions: ResolvedTarget[] = [];
    const seenRigIds = new Set<string>();
    for (const rig of allRigs) {
      if (seenRigIds.has(rig.id)) continue;
      seenRigIds.add(rig.id);
      sessions.push(...this.collectTransportTargetsForRig(rig.id, rig.name));
    }
    if (sessions.length === 0) {
      return { ok: false, code: "not_found", error: "No running sessions found. Check status with: rig ps" };
    }
    return { ok: true, sessions };
  }

  private resolveBySessionName(sessionName: string): ResolveResult {
    const sessionRows = this.db
      .prepare("SELECT node_id, session_name FROM sessions WHERE session_name = ? ORDER BY id DESC")
      .all(sessionName) as SessionRow[];

    if (sessionRows.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `Session '${sessionName}' not found. Check session names with: rig ps --nodes`,
      };
    }

    // Check for ambiguity: same session name across different rigs
    const rigNames = new Map<string, { nodeLogicalId: string }>();
    for (const row of sessionRows) {
      const nodeRow = this.db
        .prepare("SELECT rig_id, logical_id FROM nodes WHERE id = ?")
        .get(row.node_id) as NodeRow | undefined;
      if (nodeRow) {
        const rig = this.rigRepo.getRig(nodeRow.rig_id);
        if (rig) {
          rigNames.set(rig.rig.name, { nodeLogicalId: nodeRow.logical_id });
        }
      }
    }

    if (rigNames.size === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `Session '${sessionName}' not found. Check session names with: rig ps --nodes`,
      };
    }

    if (rigNames.size > 1) {
      const names = Array.from(rigNames.keys()).join(", ");
      return {
        ok: false,
        code: "ambiguous",
        error: `Session '${sessionName}' is ambiguous — found in rigs: ${names}. Specify the rig explicitly.`,
      };
    }

    const [rigName, meta] = Array.from(rigNames.entries())[0]!;
    return {
      ok: true,
      sessions: [{ sessionName, rigName, nodeLogicalId: meta.nodeLogicalId }],
    };
  }

  // OPR.0.4.3.30 — resolve an explicit list of named seats for a multi-recipient `rig send`.
  // Each name goes through the single-name resolver so a not-found / ambiguous seat is reported
  // honestly against that exact name (matching single-send semantics), and the whole command is
  // rejected rather than silently dropping a mistyped seat. Duplicate names are de-duplicated so
  // `--to a,a` delivers once. (Per-recipient GUARD independence is a send()-time concern, not a
  // resolution one — a guard refusal is one ok:false in the fan-out results, never an abort.)
  private resolveByList(sessionNames: string[]): ResolveResult {
    const sessions: ResolvedTarget[] = [];
    const seen = new Set<string>();
    for (const name of sessionNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      const resolved = this.resolveBySessionName(name);
      if (!resolved.ok) return resolved;
      sessions.push(...resolved.sessions);
    }
    if (sessions.length === 0) {
      return { ok: false, code: "not_found", error: "No target sessions provided." };
    }
    return { ok: true, sessions };
  }

  private resolveByRig(rigName: string): ResolveResult {
    const rigs = this.rigRepo.findRigsByName(rigName);
    if (rigs.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `No rig named '${rigName}' found. Check available rigs with: rig ps`,
      };
    }

    const sessions: ResolvedTarget[] = [];
    for (const rig of rigs) {
      sessions.push(...this.collectTransportTargetsForRig(rig.id, rig.name));
    }

    if (sessions.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `No running sessions found for rig '${rigName}'. Check rig status with: rig ps`,
      };
    }

    return { ok: true, sessions };
  }

  private resolveByPod(podName: string, rigName?: string): ResolveResult {
    // Get rigs to search
    const rigs = rigName
      ? this.rigRepo.findRigsByName(rigName)
      : this.rigRepo.listRigs();

    if (rigs.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: rigName
          ? `No rig named '${rigName}' found. Check available rigs with: rig ps`
          : `No rigs found. Check status with: rig ps`,
      };
    }

    // Collect running sessions across all matching rigs, deduplicated by rig ID
    const sessions: ResolvedTarget[] = [];
    const seenRigIds = new Set<string>();
    for (const rig of rigs) {
      if (seenRigIds.has(rig.id)) continue;
      seenRigIds.add(rig.id);

      for (const target of this.collectTransportTargetsForRig(rig.id, rig.name)) {
        const podPart = target.nodeLogicalId.split(".")[0];
        if (podPart === podName) {
          sessions.push(target);
        }
      }
    }

    if (sessions.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `No running sessions found for pod '${podName}'${rigName ? ` in rig '${rigName}'` : ""}. Check available pods with: rig ps --nodes`,
      };
    }

    return { ok: true, sessions };
  }

  private collectTransportTargetsForRig(rigId: string, rigName: string): ResolvedTarget[] {
    const rigSessions = this.sessionRegistry.getSessionsForRig(rigId);
    const latestByNode = new Map<string, typeof rigSessions[0]>();
    for (const session of rigSessions) {
      const existing = latestByNode.get(session.nodeId);
      if (!existing || session.id > existing.id) {
        latestByNode.set(session.nodeId, session);
      }
    }

    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return [];

    const targets: ResolvedTarget[] = [];
    for (const node of rig.nodes) {
      const binding = this.sessionRegistry.getBindingForNode(node.id);
      const latestSession = latestByNode.get(node.id);

      if (binding?.attachmentType === "external_cli" && binding.externalSessionName) {
        targets.push({
          sessionName: binding.externalSessionName,
          rigName,
          nodeLogicalId: node.logicalId,
        });
        continue;
      }

      if (latestSession?.status === "running" && binding?.tmuxSession) {
        targets.push({
          sessionName: binding.tmuxSession,
          rigName,
          nodeLogicalId: node.logicalId,
        });
      }
    }

    return targets;
  }

  deliveryTarget(sessionName: string) { return this.tmuxAdapter.deliveryGuard?.maybeTarget(sessionName) ?? null; }

  get deliveryGuard() { return this.tmuxAdapter.deliveryGuard; }

  retentionTarget(sessionName: string) {
    const guard = this.tmuxAdapter.deliveryGuard;
    const target = guard?.maybeTarget(sessionName);
    if (!guard || !target) return null;
    const pref = guard.preference(target.nodeId);
    return pref.desired || pref.effective ? target : null;
  }

  async send(sessionName: string, text: string, opts?: SendOpts): Promise<SendResult> {
    const guard = this.tmuxAdapter.deliveryGuard;
    if (!guard) return this.sendUnguarded(sessionName, text, opts);
    const outbox = new OutboxHandler(this.db);
    const ids = opts?.committedOutboxIds ?? [opts?.deliveryId ?? `guard-send-${randomUUID()}`];
    const retainedResult = (): SendResult => ({ ok: true, sessionName, outcome: "retained", sent: false, verified: false,
      outboxIds: ids, reason: "typing_guard_enabled", warning: `Retained, not delivered. Inspect with rig seat held-messages ${sessionName}; disabling does not replay held messages.` });
    try {
      if (opts?.committedOutboxIds) {
        const target = guard.target(sessionName);
        for (const id of opts.committedOutboxIds) {
          const entry = outbox.getById(id);
          if (!entry || entry.destinationSession !== sessionName) throw new Error("Committed wake target/ID mismatch");
          if (entry.guardBinding && JSON.stringify(entry.guardBinding) !== JSON.stringify(target)) {
            return { ok: false, sessionName, sent: false, reason: "guard_target_changed", error: "Committed wake recipient identity changed; no input written." };
          }
        }
      }
      // Idempotent readback also after disabling: an old retained ID never becomes a new send.
      // (P2: this readback is NOT a new retention and is outside the retained_no_write seam.)
      if (!opts?.committedOutboxIds && opts?.deliveryId) {
        const prior = outbox.getById(opts.deliveryId);
        if (prior?.guardBinding) {
          if (prior.body !== text || prior.destinationSession !== sessionName || prior.senderSession !== (opts.actorSession ?? "unknown")) {
            return { ok: false, sessionName, sent: false, reason: "delivery_identity_conflict", error: "Delivery ID names different content/identity." };
          }
          if (prior.deliveryState === "retained" || prior.deliveryState === "retired") return retainedResult();
        }
      }
      return await guard.operation(sessionName, () => this.sendUnguarded(sessionName, text, opts), async target => {
        if (opts?.submitOnly) return { ok: false, sessionName, sent: false, reason: "typing_guard_enabled", error: "Typing guard prevents submit-only; no Enter was sent." };
        this.db.transaction(() => {
          for (const id of ids) {
            const prior = opts?.committedOutboxIds ? outbox.getById(id) : null;
            if (opts?.committedOutboxIds && (!prior || prior.destinationSession !== sessionName)) throw new Error("Committed wake target/ID mismatch");
            outbox.retain(prior ? { ...prior, outboxId: id, tags: prior.tags ?? undefined, auditPointer: prior.auditPointer ?? undefined } : {
              outboxId: id, senderSession: opts?.actorSession ?? "unknown", destinationSession: sessionName, body: text, auditPointer: opts?.auditPointer,
            }, target, !!opts?.committedOutboxIds);
          }
        })();
        // P2: observed only after the retention above committed; a submit-only
        // refusal or a failed retention never reaches here. Never delivery evidence.
        if (this.captureObserver) {
          safeRecord(this.captureObserver, {
            seam: "retained_no_write",
            attemptId: randomUUID(),
            binding: { sessionName, nodeId: target.nodeId, occupant: target.occupant, pane: target.pane },
            runtime: null,
            sentHash: hashSentText(text),
            pre: { state: "not_requested" },
            post: { state: "not_requested" },
            regexResult: { outcome: "retained", reason: "typing_guard_enabled" },
            completedAt: this.now().toISOString(),
          });
        }
        return retainedResult();
      });
    } catch (error) {
      return { ok: false, sessionName, sent: false, reason: (error as { code?: string }).code ?? "guard_unavailable", error: (error as Error).message };
    }
  }

  private async sendUnguarded(sessionName: string, text: string, opts?: SendOpts): Promise<SendResult> {
    let preVerifyContent: string | null = null;
    const sessionMeta = this.getSessionMeta(sessionName);
    const runtime = sessionMeta.runtime;
    let runtimeAdvisory: string | undefined;
    const bindingChanged = () => JSON.stringify(this.getSessionMeta(sessionName)) !== JSON.stringify(sessionMeta);
    const changedRecipient = (sent = false): SendResult => ({ ok: false, sessionName, sent, reason: "target_runtime_conflict",
      error: sent ? "Recipient binding changed after paste; Enter was not sent." : "Recipient binding changed; no text was sent." });
    const checkClaudeTarget = async (): Promise<SendResult | null> => {
      if (runtime !== "claude-code") return null;
      if (bindingChanged()) return changedRecipient();
      const observation = await this.claudeDeliveryObservation(sessionName, sessionMeta.pane, sessionMeta.resumeToken);
      if (bindingChanged()) return changedRecipient();
      if (observation.state === "idle_shell" || observation.state === "conflict") {
        return { ok: false, sessionName, sent: false, reason: observation.state === "idle_shell" ? "target_runtime_not_running" : "target_runtime_conflict",
          error: `Refused: ${observation.detail}. No text was sent.` };
      }
      if (observation.state === "unknown") runtimeAdvisory = `runtime: ${observation.detail}; delivery proceeds without verified native identity.`;
      return null;
    };
    // S01/S02 P2 observation context, frozen at attempt entry before any await.
    const observed = this.captureObserver ? {
      attemptId: randomUUID(),
      binding: Object.freeze({ sessionName, nodeId: sessionMeta.nodeId, occupant: sessionMeta.occupant, pane: sessionMeta.pane }),
      pre: (opts?.verify ? { state: "not_reached" } : { state: "not_requested" }) as CaptureSlot,
      post: (opts?.verify ? { state: "not_reached" } : { state: "not_requested" }) as CaptureSlot,
      sentHash: null as string | null,
    } : null;
    const observe = (result: SendResult): SendResult => {
      if (result.ok && runtimeAdvisory) result = { ...result, warning: [runtimeAdvisory, result.warning].filter(Boolean).join(" ") };
      if (observed && this.captureObserver) {
        safeRecord(this.captureObserver, {
          seam: "send_verify",
          attemptId: observed.attemptId,
          binding: observed.binding,
          runtime,
          sentHash: observed.sentHash,
          pre: observed.pre,
          post: observed.post,
          regexResult: pickDefined(result, ["ok", "outcome", "verified", "reason"]),
          completedAt: this.now().toISOString(),
        });
      }
      return result;
    };
    const waitForIdleMs = opts?.waitForIdleMs;
    const waitMode = waitForIdleMs !== undefined;
    let waitEvidence: Pick<SendResult, "activity" | "waitedMs" | "attempts"> = {};

    if (sessionMeta.attachmentType === "external_cli") {
      return {
        ok: false,
        sessionName,
        reason: "transport_unavailable",
        error: `Session '${sessionName}' is attached as an external CLI node. Inbound tmux transport is unavailable for this target.`,
      };
    }

    // #142 — a shell label may be an idle shell or a managed launch wrapper.
    // Non-Claude runtimes retain their existing proof requirement. Claude ordinary
    // delivery applies its distinct uncertainty policy at the input boundary below.
    const unverifiedShell = runtime && runtime !== "terminal" && runtime !== "claude-code"
      ? await this.unverifiedShellForeground(sessionName, runtime, sessionMeta.pane, sessionMeta.resumeToken) : null;
    if (unverifiedShell) {
      return observe({
        ok: false,
        sessionName,
        sent: false,
        reason: "target_runtime_unverified",
        error: `Refused: '${sessionName}' reports ${unverifiedShell} as the foreground command, but OpenRig could not verify its expected ${runtime} agent in the bound pane. The agent may still be running behind a wrapper. No text was sent.`,
      });
    }

    if (waitForIdleMs !== undefined) {
      if (opts?.force) {
        return {
          ok: false,
          sessionName,
          reason: "invalid_wait_for_idle",
          error: "--wait-for-idle cannot be combined with force. No text was sent.",
          sent: false,
        };
      }
      if (!Number.isFinite(waitForIdleMs) || waitForIdleMs <= 0) {
        return {
          ok: false,
          sessionName,
          reason: "invalid_wait_for_idle",
          error: "waitForIdleMs must be a positive number. No text was sent.",
          sent: false,
        };
      }
    }

    // 1. Resolve the session through the classified probe (OPR.0.5.4.2): a
    // transport blip must never read as a dead seat, and absence is only ever
    // asserted on positive tmux evidence.
    try {
      const probe = await this.tmuxAdapter.probeSession(sessionName);
      if (probe.state === "absent") {
        this.recordSessionMissingVerdict(sessionName);
        return {
          ok: false,
          sessionName,
          reason: "session_missing",
          error: `Session '${sessionName}' not found: tmux reports no session with this name. No text was sent. Check available sessions with: rig ps --nodes`,
        };
      }
      if (probe.state === "transport_unavailable") {
        return {
          ok: false,
          sessionName,
          reason: "tmux_unavailable",
          error: `The tmux server could not be reached (${probe.cause}). Whether session '${sessionName}' exists was not determined. No text was sent.`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        sessionName,
        reason: "tmux_unavailable",
        error: `The tmux session probe failed unexpectedly (${err instanceof Error ? err.message : String(err)}). Whether session '${sessionName}' exists was not determined. No text was sent.`,
      };
    }

    // SUBMIT-ONLY (mechanics-gate fix, desk ruling d9b3989a): the single Enter retry for staged
    // text. Types NOTHING; verifies the pane actually holds the expected staged text FIRST, so a
    // bare Enter can never land on anything else (a permission prompt, someone else's input).
    if (opts?.submitOnly) {
      if (text.length > 0) {
        return { ok: false, sessionName, reason: "invalid_submit_only", error: "submitOnly sends no text — the text argument must be empty." };
      }
      const expected = opts.expectedStagedText ?? "";
      if (expected.trim().length === 0) {
        return { ok: false, sessionName, reason: "invalid_submit_only", error: "submitOnly requires expectedStagedText — the Enter is only pressed onto the exact staged content." };
      }
      const recordMismatch = (pane: string | null): void => {
        if (!opts.requireFullStagedText || !opts.onStartupMismatch) return;
        try {
          const evidence = startupSubmissionEvidence(pane, expected, opts.submitOnlyCaptureLines ?? 50);
          if (evidence) opts.onStartupMismatch(evidence);
        } catch { /* Observation has no delivery authority. */ }
      };
      let pane: string | null;
      try {
        pane = await this.runStage(
          "session_transport.submit_only_precheck",
          () => this.tmuxAdapter.capturePaneContent(sessionName, opts.submitOnlyCaptureLines ?? 50),
        );
      } catch (error) {
        recordMismatch(null);
        throw error; // Preserve the existing guarded/unguarded error handling.
      }
      const staged = opts.requireFullStagedText
        ? inspectStartupStagedText(pane, expected) === "staged"
        : hasExpectedStagedText(pane, expected);
      if (!staged) {
        recordMismatch(pane);
        return {
          ok: false,
          sessionName,
          reason: "staged_mismatch",
          error: `submitOnly refused: the pane of '${sessionName}' does not show the expected staged text — pressing Enter here could drive something else entirely. Nothing was submitted.`,
        };
      }
      const targetFailure = await checkClaudeTarget();
      if (targetFailure) return targetFailure;
      const submitResult = await this.runStage(
        "session_transport.submit",
        () => this.tmuxAdapter.sendKeys(sessionName, ["Enter"]),
        (result) => result.ok ? "ok" : "failed",
      );
      if (!submitResult.ok) {
        return { ok: false, sessionName, reason: "submit_failed", outcome: "failed", error: `submitOnly: Enter did not land on '${sessionName}': ${submitResult.message}` };
      }
      return observe({ ok: true, sessionName, outcome: "rendered-unconfirmed", submitOnly: true });
    }

    if (waitForIdleMs !== undefined) {
      const waitResult = await this.waitForIdle({
        sessionName,
        runtime,
        attachmentType: sessionMeta.attachmentType,
        timeoutMs: waitForIdleMs,
        binding: observed?.binding,
      });
      waitEvidence = {
        activity: waitResult.activity,
        waitedMs: waitResult.waitedMs,
        attempts: waitResult.attempts,
      };
      if (!waitResult.ok) {
        return {
          ok: false,
          sessionName,
          reason: waitResult.reason,
          error: waitResult.error,
          sent: false,
          ...waitEvidence,
        };
      }
    }

    // 2. OPR.0.4.1.10 — robust prompt/permission + mid-work guard on the DEFAULT path.
    // Runs the same detector previously reachable only via --wait-for-idle: fresh runtime-hook primary
    // (within the send-readiness window) + hardened capture-pane fallback. This closes the rig-send
    // prompt-injection footgun — a message can never select/submit/approve another agent's prompt by
    // default. OPR.0.4.3.28 correction + fast-follow: only POSITIVE picker/approval evidence
    // (needs_input) FAILS CLOSED (refuse, or an audited --dangerously-interact override). Every other
    // state now PROCEEDS with a non-blocking advisory: UNKNOWN (absent/stale/failed telemetry) and
    // RUNNING (mid-work, busy) both send-and-advise — busy/uncertain is not authority to block
    // communication. --force is a no-op on this path now (kept for back-compat) and never bypasses
    // the positive-picker guard (FR-4 — the footgun separation). The advisory is carried on the
    // success result via `warning` so the honest telemetry is surfaced.
    let sendAdvisory: string | undefined;
    let promptOverride = false;
    if (waitForIdleMs === undefined) {
      const readiness = await this.classifySendReadiness({
        sessionName,
        runtime,
        attachmentType: sessionMeta.attachmentType,
        binding: observed?.binding,
      });

      // Single state dispatch (B1 code-review fix): flattened so `unknown` ALWAYS attaches the advisory
      // regardless of whether --dangerously-interact was passed — the deliberate-override branch no
      // longer bypasses unknown handling.
      if (readiness.state === "needs_input") {
        // The POSITIVE picker/approval footgun. --dangerously-interact is the deliberate audited
        // override (reason required + an auditable record persisted BEFORE the send; fail closed if it
        // cannot be audited so an unauditable override never sends). Otherwise refuse with the
        // proceed-path. This is the ONLY state --dangerously-interact bypasses.
        if (opts?.dangerouslyInteract) {
          if (!opts.reason || opts.reason.trim().length === 0) {
            return {
              ok: false,
              sessionName,
              reason: "dangerously_interact_requires_reason",
              error: "--dangerously-interact requires --reason explaining why the prompt is being driven. No text was sent.",
            };
          }
          const audit = this.recordPromptOverride({
            sessionName,
            readiness,
            actorSession: opts.actorSession ?? null,
            overrideReason: opts.reason,
          });
          if (!audit.ok) {
            return {
              ok: false,
              sessionName,
              reason: "prompt_override_audit_unavailable",
              activity: readiness,
              error: `Refused: --dangerously-interact requires an auditable override record, which could not be persisted (${audit.reason}). No text was sent.`,
            };
          }
          // Audited answers use unbracketed input; a choice may submit itself.
          promptOverride = true;
        } else {
          return {
            ok: false,
            sessionName,
            reason: "target_needs_input",
            activity: readiness,
            error: `Refused: '${sessionName}' is at an interactive prompt (${readiness.reason}). A message must not select or approve it. To deliberately drive the prompt: rig send ${sessionName} "<text>" --dangerously-interact --reason "<why>". No text was sent.`,
          };
        }
      } else if (readiness.state === "unknown") {
        // OPR.0.4.3.28 correction — INVERT the fail-closed-on-unknown default. Absent/stale/failed
        // telemetry is NOT positive picker evidence, so the send PROCEEDS. Diagnose the producer link
        // and carry it as a NON-blocking advisory (`warning` on the success result) — ALWAYS, whether
        // or not --dangerously-interact was passed (B1 code-review fix) — so the honest telemetry is
        // surfaced without ever blocking communication. Hooks are advisory telemetry, not authority
        // over whether agents can talk.
        const linkDiagnosis = await this.diagnoseProducerLink(sessionName);
        sendAdvisory = `producer-link: ${linkDiagnosis} — activity could not be determined (${readiness.reason}); sent anyway (telemetry is advisory).`;
        // fall through to the send below.
      } else if (readiness.state === "running") {
        // OPR.0.4.3.28 fast-follow (advisor audit-catch, pm-ruled a founder-principle residual):
        // busy is NOT a block. Downgrade the old mid_work HARD REFUSE to a non-blocking advisory —
        // attach it on the success result + PROCEED (mirrors the unknown inversion). --force is now a
        // no-op here (the option is kept for back-compat). needs_input (positive picker) remains the
        // ONLY hard refuse; unknown/stale/missing already proceed-with-advisory above.
        sendAdvisory = `target pane appears mid-task; sent anyway (busy is advisory, not a block).`;
        // fall through to the send below.
      }
      // idle (or running/unknown — now advisory-and-proceed) → proceed to send.
    }

    if (opts?.verify) {
      const captureSeq = observed ? nextCaptureSeq++ : 0;
      try {
        preVerifyContent = await this.runStage(
          "session_transport.pre_capture",
          () => this.tmuxAdapter.capturePaneContent(sessionName, 30),
        );
        if (observed) observed.pre = captureSlot(preVerifyContent, this.now().toISOString(), captureSeq);
      } catch {
        preVerifyContent = null;
        if (observed) observed.pre = { state: "unavailable", cause: "capture_error", capturedAt: this.now().toISOString(), captureSeq };
      }
    }

    // GHOST-STAGE (h): delivered-at latency. At the WRITE moment (after any idle-wait), stamp how long
    // the message waited since it was composed (opts.stampISO). appendDeliveredSegment flags ONLY a
    // genuinely delayed delivery (≥ 10s) — a delayed-lifecycle-message forensic — and is a no-op for
    // sub-threshold gaps or unenveloped sends. sent-ISO + the rendered delta = absolute delivered time.
    if (opts?.stampISO) {
      text = appendDeliveredSegment(text, this.now().getTime() - Date.parse(opts.stampISO));
    }

    // Recheck the selected recipient after readiness/capture awaits, at the input boundary.
    const targetFailure = await checkClaudeTarget();
    if (targetFailure) return observe(targetFailure);

    // 3. Deliver ordinary messages as paste, audited prompt answers as key input.
    if (observed) observed.sentHash = hashSentText(text);
    const textResult = await this.runStage(
      "session_transport.send_text",
      () => {
        opts?.beforeWrite?.();
        if (promptOverride) return this.tmuxAdapter.sendText(sessionName, text, opts?.beforeWrite, { bracketed: false });
        return opts?.beforeWrite ? this.tmuxAdapter.sendText(sessionName, text, opts.beforeWrite) : this.tmuxAdapter.sendText(sessionName, text);
      },
      (result) => result.ok ? "ok" : "failed",
    );
    if (!textResult.ok) {
      return observe({
        ok: false,
        sessionName,
        reason: "send_failed",
        outcome: "failed",
        error: `Failed to send text to '${sessionName}': ${textResult.message}`,
        ...(waitMode ? { sent: false, ...waitEvidence } : {}),
      });
    }

    // 4. Wait 200ms (spike-proven delay)
    await this.sleep(200);

    if (runtime === "claude-code" && bindingChanged()) return observe(changedRecipient(true));

    if (promptOverride) {
      const pane = await this.runStage("session_transport.prompt_override_pre_submit_capture",
        () => this.tmuxAdapter.capturePaneContent(sessionName, 50)).catch(() => null);
      if (runtime === "claude-code" && bindingChanged()) return observe(changedRecipient(true));
      if (!promptAnswerStaged(pane, text, runtime)) {
        return observe({ ok: true, sessionName, sent: true, verified: false, outcome: "rendered-unconfirmed", promptInteraction: "unverified",
          warning: "prompt-override: answer sent as unbracketed input; submission unverified. No trailing Enter: the complete answer is not visibly staged (it may have been consumed, the prompt changed, or observation is unavailable)." });
      }
      sendAdvisory = "prompt-override: answer sent as unbracketed input; Enter submitted the complete still-staged answer.";
    }

    // 5. Submit (Enter)
    const submitResult = await this.runStage(
      "session_transport.submit",
      () => { opts?.beforeWrite?.(); return opts?.beforeWrite ? this.tmuxAdapter.sendKeys(sessionName, ["Enter"], opts.beforeWrite) : this.tmuxAdapter.sendKeys(sessionName, ["Enter"]); },
      (result) => result.ok ? "ok" : "failed",
    );
    if (!submitResult.ok) {
      return observe({
        ok: false,
        sessionName,
        reason: "submit_failed",
        outcome: "failed",
        error: `Text is visible in '${sessionName}' but was not submitted (Enter failed). The agent may need manual attention.`,
        ...(waitMode ? { sent: true, ...waitEvidence } : {}),
      });
    }

    const interaction = promptOverride ? { promptInteraction: "enter-sent" as const } : {};

    // 6. Verify if requested. At this point text + Enter BOTH succeeded, so the
    // message LANDED; the capture only re-confirms the render. Not re-confirming
    // (a TUI redraw race, or the capture throwing) is therefore the honest
    // middle outcome `rendered-unconfirmed` — never a failure (OPR.99.0.6.3).
    if (opts?.verify) {
      await this.sleep(500);
      const captureSeq = observed ? nextCaptureSeq++ : 0;
      try {
        const content = await this.runStage(
          "session_transport.post_capture",
          () => this.tmuxAdapter.capturePaneContent(sessionName, 30),
        );
        if (observed) observed.post = captureSlot(content, this.now().toISOString(), captureSeq);
        const snippet = text.substring(0, Math.min(text.length, 40));
        const preCount = countOccurrences(preVerifyContent ?? "", snippet);
        const postCount = countOccurrences(content ?? "", snippet);
        const verified = postCount > preCount;
        return observe({ ok: true, sessionName, ...interaction, verified, outcome: verified ? "delivered" : "rendered-unconfirmed", ...(sendAdvisory ? { warning: sendAdvisory } : {}), ...(waitMode ? { sent: true, ...waitEvidence } : {}) });
      } catch {
        if (observed && observed.post.state === "not_reached") {
          observed.post = { state: "unavailable", cause: "capture_error", capturedAt: this.now().toISOString(), captureSeq };
        }
        return observe({ ok: true, sessionName, ...interaction, verified: false, outcome: "rendered-unconfirmed", ...(sendAdvisory ? { warning: sendAdvisory } : {}), ...(waitMode ? { sent: true, ...waitEvidence } : {}) });
      }
    }

    return observe({ ok: true, sessionName, ...interaction, ...(sendAdvisory ? { warning: sendAdvisory } : {}), ...(waitMode ? { sent: true, ...waitEvidence } : {}) });
  }

  private runStage<T>(
    site: string,
    fn: () => Promise<T>,
    classify?: (value: T) => "ok" | "failed",
  ): Promise<T> {
    return this.slowOpRecorder?.runStage
      ? this.slowOpRecorder.runStage(site, fn, classify)
      : fn();
  }

  /** Wait on the existing classifier without occupying the input/lifecycle lease. */
  async waitUntilIdle(sessionName: string, timeoutMs: number, signal?: AbortSignal) {
    const meta = this.getSessionMeta(sessionName);
    return this.waitForIdle({ sessionName, runtime: meta.runtime, attachmentType: meta.attachmentType, timeoutMs, signal,
      binding: { sessionName, nodeId: meta.nodeId, occupant: meta.occupant, pane: meta.pane } });
  }

  private async waitForIdle(input: {
    sessionName: string;
    runtime: string | null;
    attachmentType: string | null;
    timeoutMs: number;
    signal?: AbortSignal;
    binding?: ObservedBinding;
  }): Promise<
    | { ok: true; activity: AgentActivity; waitedMs: number; attempts: number }
    | { ok: false; reason: string; error: string; activity: AgentActivity; waitedMs: number; attempts: number }
  > {
    // ONE deadline. UNKNOWN is retried like busy and never authorizes the send. No observation
    // starts after the deadline (one starting exactly at it races a 0 ms timer), each one is raced
    // against the time left, and one that completes after the deadline is discarded, so a late idle
    // can never lead to input. At expiry the result names the last observation that completed in
    // time; waitedMs is the wait itself.
    const deadline = Date.now() + input.timeoutMs;
    let attempts = 0;
    let last: AgentActivity | null = null;
    const expire = () => {
      const count = `${attempts} observation${attempts === 1 ? "" : "s"}`;
      const activity: AgentActivity = last ?? {
        state: "unknown", reason: "no_observation_in_time", evidenceSource: "pane_heuristic",
        sampledAt: this.now().toISOString(), evidence: null,
      };
      return activity.state === "unknown"
        ? {
          ok: false as const,
          reason: "target_activity_unknown",
          error: last
            ? `Target activity could not be determined (${activity.reason}) when the ${input.timeoutMs}ms wait ended (${count}). No text was sent.`
            : `Target activity could not be determined: no observation completed within the ${input.timeoutMs}ms wait. No text was sent.`,
          activity, waitedMs: input.timeoutMs, attempts,
        }
        : {
          ok: false as const,
          reason: "wait_for_idle_timeout",
          error: `Target was still busy (${activity.reason}) when the ${input.timeoutMs}ms wait ended (${count}). No text was sent.`,
          activity, waitedMs: input.timeoutMs, attempts,
        };
    };

    const cancelled = () => ({
      ok: false as const,
      reason: "preparation_cancelled",
      error: "Managed preparation ended; no compact authorized.",
      activity: last ?? {
        state: "unknown" as const, reason: "preparation_cancelled", evidenceSource: "pane_heuristic" as const,
        sampledAt: this.now().toISOString(), evidence: null,
      },
      waitedMs: Math.max(0, Math.min(input.timeoutMs, input.timeoutMs - (deadline - Date.now()))),
      attempts,
    });

    while (true) {
      if (input.signal?.aborted) return cancelled();
      if (attempts > 0 && Date.now() > deadline) return expire();
      attempts++;
      const activity = await this.observeReadinessWithin(input, deadline - Date.now());
      if (input.signal?.aborted) return cancelled();
      if (activity === null || Date.now() > deadline) return expire();
      last = activity;
      const waitedMs = input.timeoutMs - (deadline - Date.now());

      if (activity.state === "idle") {
        return { ok: true, activity, waitedMs, attempts };
      }

      if (activity.state === "needs_input") {
        return {
          ok: false,
          reason: "target_needs_input",
          error: `Target requires attention (${activity.reason}). No text was sent.`,
          activity,
          waitedMs,
          attempts,
        };
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return expire();
      await this.sleep(Math.min(this.waitForIdlePollMs, remainingMs));
    }
  }

  /** One readiness observation, raced against the time left before the wait's deadline. Null
   *  when the deadline wins; the abandoned observation is ignored, never delivered on. */
  private async observeReadinessWithin(
    input: { sessionName: string; runtime: string | null; attachmentType: string | null; binding?: ObservedBinding },
    remainingMs: number,
  ): Promise<AgentActivity | null> {
    const observation = this.classifySendReadiness(input);
    observation.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        observation,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, remainingMs)); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async claudeDeliveryObservation(sessionName: string, pane: string | null, resumeToken: string | null): Promise<ClaudeDeliveryObservation> {
    const unknown = { state: "unknown" as const, detail: "Claude runtime observation or older launch binding is unavailable" };
    try {
      const panes = await this.tmuxAdapter.listPanes(sessionName);
      if (panes.length > 1 || (pane && panes.length === 1 && panes[0]!.id !== pane)) {
        return { state: "conflict", detail: "The session does not have the single expected bound pane" };
      }
      if (!pane || panes.length === 0) return unknown;
      const [sessionPid, panePid] = await Promise.all([this.tmuxAdapter.getPanePid(sessionName), this.tmuxAdapter.getPanePid(pane)]);
      if (sessionPid && panePid && sessionPid !== panePid) return { state: "conflict", detail: "The session and bound pane name different processes" };
      const observation = await observeClaudeDelivery({ target: pane, tmux: this.tmuxAdapter, listProcesses: this.listProcesses, expectedToken: resumeToken });
      // Refusal already has positive evidence; a later failed read cannot erase it.
      if (observation.state === "conflict" || observation.state === "idle_shell") return observation;
      const after = await this.tmuxAdapter.listPanes(sessionName);
      if (after.length > 1 || (after.length === 1 && after[0]!.id !== pane)) return { state: "conflict", detail: "The bound pane changed during delivery verification" };
      const currentPid = await this.tmuxAdapter.getPanePid(pane);
      if (panePid && currentPid && panePid !== currentPid) return { state: "conflict", detail: "The bound pane process changed during delivery verification" };
      return after.length === 0 || !sessionPid || !panePid || !currentPid ? unknown : observation;
    } catch { return unknown; }
  }

  /** Shell label without positive native proof; not proof of an idle shell or stopped agent.
   * Null when no shell label is observed, or the expected native process is verified. */
  private async unverifiedShellForeground(sessionName: string, runtime: string, pane: string | null, resumeToken: string | null): Promise<string | null> {
    let paneCommand: string | null;
    try {
      paneCommand = await this.tmuxAdapter.getPaneCommand(sessionName);
    } catch {
      return null;
    }
    if (!paneCommand || !isShellForeground(paneCommand)) return null;
    if (runtime === "codex" && pane) {
      // Reuse stable, foreground, pane-descendant Codex proof. A resumed process
      // must name this session's token. Stale UI, a Node
      // launcher alone, missing observations or a native process elsewhere cannot clear it.
      const native = await verifyCodexPaneProcess({ target: sessionName, tmux: this.tmuxAdapter,
        listProcesses: this.listProcesses, expectedToken: resumeToken });
      if (native && await this.tmuxAdapter.getPanePid(pane).catch(() => null) === native.panePid) return null;
    }
    return paneCommand.replace(/^-/, "");
  }

  private async classifySendReadiness(input: {
    sessionName: string;
    runtime: string | null;
    attachmentType: string | null;
    binding?: ObservedBinding;
  }): Promise<AgentActivity> {
    const now = this.now();
    const hookActivity = this.agentActivityStore?.getLatestForNode({
      sessionName: input.sessionName,
      now,
    });
    // Use the fresh runtime-hook as the authoritative signal ONLY within the tight send-readiness
    // window. Beyond it (but still inside the looser display freshness) the hook is too old to prove
    // "safe to send now" — fall through to the real-time capture-pane probe (also Codex's sole guard).
    if (
      hookActivity &&
      hookActivity.evidenceSource === "runtime_hook" &&
      hookActivity.stale !== true
    ) {
      // Fresh hook (within the 15s send window): authoritative for any state.
      if (this.hookFreshForSend(hookActivity, now)) {
        return hookActivity;
      }
      // OPR.0.4.3.28 Part A — a stale-but-latest `idle` hook (older than the 15s
      // send window but still within the 5-min store window, so stale!==true) is
      // SENDABLE. getLatestForNode returns the single newest event by seq, so a
      // latest hook still `idle` proves no newer activity exists (had the seat
      // started work, the latest hook would be UserPromptSubmit/PermissionRequest).
      // A stale NON-idle hook (running/needs_input >15s) still falls through to
      // the pane probe below. No 15s widen; scoped to stale!==true so a
      // truly-abandoned seat (>5min) still degrades to the probe.
      if (hookActivity.state === "idle") {
        // Guard code-review 2026-07-02 (Blocker 1): a NARROW real-time veto
        // before trusting the stale-idle hook — never paste+Enter onto a VISIBLE
        // picker/permission prompt. Only a POSITIVE needs_input from the pane
        // vetoes (→ refuse); an unknown pane (the flaky-Codex case this trust
        // exists for) or a clean idle pane does NOT veto → trust the stale hook.
        const paneVeto = await probeSessionActivity({
          sessionName: input.sessionName,
          runtime: input.runtime,
          attachmentType: input.attachmentType as "tmux" | "external_cli" | null | undefined,
          tmuxAdapter: this.tmuxAdapter,
          now,
          captureObserver: this.captureObserver,
          binding: input.binding,
        });
        if (paneVeto.state === "needs_input") {
          return paneVeto;
        }
        return hookActivity;
      }
    }

    const probe = await probeSessionActivity({
      sessionName: input.sessionName,
      runtime: input.runtime,
      attachmentType: input.attachmentType as "tmux" | "external_cli" | null | undefined,
      tmuxAdapter: this.tmuxAdapter,
      now,
      captureObserver: this.captureObserver,
      binding: input.binding,
    });
    // A Codex empty-composer placeholder is also on screen while Codex streams with its status
    // row hidden, so a placeholder-only idle verdict must not override a display-fresh (<5min)
    // running/needs_input hook such as UserPromptSubmit: keep it until it ages out. An `unknown`
    // hook (e.g. SessionStart) carries no evidence of work and does not block.
    if (
      probe.state === "idle" &&
      probe.reason === "idle_prompt" &&
      CODEX_EMPTY_COMPOSER_PATTERN.test(probe.evidence ?? "") &&
      hookActivity &&
      hookActivity.evidenceSource === "runtime_hook" &&
      hookActivity.stale !== true &&
      (hookActivity.state === "running" || hookActivity.state === "needs_input")
    ) {
      return hookActivity;
    }
    return probe;
  }

  // OPR.0.4.1.10 — a runtime-hook is authoritative for send-readiness only within the tight send
  // window. No usable hook timestamp → not send-fresh (fall through to real-time capture).
  private hookFreshForSend(activity: AgentActivity, now: Date): boolean {
    const eventMs = activity.eventAt ? Date.parse(activity.eventAt) : NaN;
    if (!Number.isFinite(eventMs)) return false;
    return now.getTime() - eventMs <= this.sendReadinessFreshnessMs;
  }

  // OPR.0.4.3.28 Part C — producer-link diagnostic. When a send fails closed on
  // `unknown` (no usable activity signal), name WHICH link in the hook→activity
  // producer chain is broken + the next step, instead of an opaque
  // `no_activity_signal`. NEVER surfaces a token value — env checks are
  // presence-only, and the store carries no token.
  private async diagnoseProducerLink(sessionName: string): Promise<string> {
    // Link 1 — the relay's prerequisites: the daemon URL, the activity token, and the runtime
    // (without OPENRIG_RUNTIME the relay builds no payload and posts nothing). Only the tmux SESSION
    // environment is inspected; the agent process's own environment is not read, and an env-prefixed
    // launch carries these without the session environment showing them. So a name absent from the
    // session environment is reported as UNPROVEN absent from the agent: UNKNOWN, never DOWN.
    let hasUrl: boolean | null = null;
    let hasToken: boolean | null = null;
    let hasRuntime: boolean | null = null;
    if (typeof this.tmuxAdapter?.hasSessionEnv === "function") {
      const anyPresent = async (names: string[]): Promise<boolean | null> => {
        let unknown = false;
        for (const name of names) {
          try {
            const present = await this.tmuxAdapter.hasSessionEnv(sessionName, name);
            if (present === true) return true;
            if (present === null) unknown = true;
          } catch {
            unknown = true;
          }
        }
        return unknown ? null : false;
      };
      hasUrl = await anyPresent(["OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT", "RIGGED_PORT"]);
      hasToken = await anyPresent(["OPENRIG_ACTIVITY_HOOK_TOKEN", "RIGGED_ACTIVITY_HOOK_TOKEN"]);
      hasRuntime = await anyPresent(["OPENRIG_RUNTIME", "RIGGED_RUNTIME"]);
    }
    let fileEndpoint: { baseUrl: string; token: string } | null = null;
    try {
      fileEndpoint = this.activityEndpointFile();
    } catch { /* unreadable fallback remains unavailable */ }
    // The endpoint file covers the URL and token, never the runtime. Presence-only: no value is read out.
    const prerequisites = [
      { label: "relay URL", present: fileEndpoint ? true : hasUrl },
      { label: "activity token", present: fileEndpoint ? true : hasToken },
      { label: "OPENRIG_RUNTIME", present: hasRuntime },
    ];
    const absent = prerequisites.filter((p) => p.present === false).map((p) => p.label);
    const unread = typeof this.tmuxAdapter?.hasSessionEnv === "function"
      ? prerequisites.filter((p) => p.present === null).map((p) => p.label) : [];
    const envNote = absent.length > 0 || unread.length > 0
      ? `seat-env UNKNOWN — ${[
        absent.length > 0 ? `${absent.join(", ")} absent from the tmux session environment` : null,
        unread.length > 0 ? `session-environment lookup failed for ${unread.join(", ")}` : null,
      ].filter(Boolean).join("; ")}; the agent process environment was not inspected and an env-prefixed launch can still carry them, so absence from the agent is unproven`
      : null;
    const withEnv = (verdict: string) => envNote ? `${verdict}. ${envNote}` : verdict;

    // Link 2 — the DAEMON INGEST + store: did any hook land, and how old is it?
    const store = this.agentActivityStore;
    if (!store) {
      return withEnv(`daemon-ingest link DOWN — the activity store is not configured on this daemon (ingest returns 503)`);
    }
    const latest = store.getLatestForNode({ sessionName, now: this.now() });
    if (!latest || latest.evidenceSource !== "runtime_hook") {
      return withEnv(`no activity hook is stored for this seat — which link failed is not identified: the relay may never have posted (it needs OPENRIG_RUNTIME, the relay URL and the token in the agent process), Codex hook-trust may be uncleared, or ingest may have rejected posts (401 token mismatch, 503 unconfigured)`);
    }
    const ageMs = latest.eventAt ? this.now().getTime() - Date.parse(latest.eventAt) : NaN;
    const ageText = Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s ago` : "at an unknown time";
    const recent = Number.isFinite(ageMs) && ageMs <= store.freshnessMs;
    // W2a-1 — a GENERATION verdict is stale:true even for a RECENT hook; collapsing a recent one to
    // "seat quiet" mislabels per-path missing carry / dead-tenure as a DARK seat. Age is checked FIRST
    // so an old hook is never called recent; its generation verdict is still reported, separately.
    if (latest.stale === true && typeof latest.reason === "string" && latest.reason.startsWith("generation_")) {
      if (!recent) {
        const verdict: Record<string, string> = {
          generation_unverifiable: "it carried NO occupant generation",
          generation_unresolvable: "the LIVE occupant generation could not be resolved",
          generation_mismatch: "it belongs to a PRIOR occupant generation (a dead tenure)",
          generation_resolver_error: "the occupant-generation resolver errored",
        };
        return withEnv(`producer link STALE — the last activity hook arrived ${ageText}, beyond the ${Math.round(store.freshnessMs / 1000)}s store window, and ${verdict[latest.reason] ?? `its generation verdict is ${latest.reason}`}; no recent hook from this live occupant`);
      }
      // A recent hook not verified as the LIVE occupant's says nothing about this occupant's own
      // producer prerequisites, so none of these is "producer link OK" and each keeps the env note.
      const age = ageText;
      switch (latest.reason) {
        case "generation_unverifiable":
          // Carried generation was null on THIS hook. Managed launch and fresh-handover producers carry
          // it; legacy/excluded launch paths or an occupant with no tenure at fire time may not. Sound,
          // not dark; not a quiet seat.
          return withEnv(`hook received, producer unverified — a recent hook exists (${age}) but carried NO occupant generation; the emitting launch path supplied NO occupant generation (legacy/excluded path), or the emitting occupant had no tenure at fire time. Generation UNVERIFIABLE, not a quiet seat`);
        case "generation_unresolvable":
          return withEnv(`hook received, producer unverified — a recent hook exists (${age}) but the LIVE occupant generation could not be resolved (no tenure row); generation UNRESOLVABLE, not a quiet seat`);
        case "generation_mismatch":
          return withEnv(`hook received from a prior occupant — a recent hook exists (${age}) but it belongs to a PRIOR occupant generation (a dead tenure), not this live occupant; it is no evidence for this occupant's producer`);
        case "generation_resolver_error":
          return withEnv(`hook received, producer unverified — a recent hook exists (${age}) but the occupant-generation resolver errored; generation verdict DEGRADED, not a quiet seat`);
      }
    }
    if (latest.stale === true) {
      return withEnv(`producer link STALE — the last activity hook arrived ${ageText} (beyond the store window); the seat has gone quiet or its hooks stopped firing`);
    }
    return `a recent activity hook exists but the live pane probe could not confirm idle (possible identity mismatch between the seat env, the DB, and the stored payload)`;
  }

  // OPR.0.4.1.10 — persist the audit record for a --dangerously-interact prompt override. Audit-all-
  // or-nothing: if there is no eventBus, the target rig/node can't be resolved, or the event cannot be
  // persisted, return !ok so the caller fails closed and does NOT send. Payload keeps the caller's
  // overrideReason distinct from the classifier's detectedReason/evidenceSource (not overloaded).
  private recordPromptOverride(input: {
    sessionName: string;
    readiness: AgentActivity;
    actorSession: string | null;
    overrideReason: string | null;
  }): { ok: true } | { ok: false; reason: string } {
    if (!this.eventBus) return { ok: false, reason: "audit_unconfigured" };
    const resolved = this.agentActivityStore?.resolveSession({ sessionName: input.sessionName });
    if (!resolved) return { ok: false, reason: "session_unresolved" };
    try {
      this.eventBus.emit({
        type: "transport.prompt_override",
        rigId: resolved.rigId,
        nodeId: resolved.nodeId,
        sessionName: resolved.sessionName,
        actorSession: input.actorSession,
        detectedState: input.readiness.state,
        detectedReason: input.readiness.reason,
        evidenceSource: input.readiness.evidenceSource,
        overrideReason: input.overrideReason,
      });
      return { ok: true };
    } catch {
      return { ok: false, reason: "audit_persist_failed" };
    }
  }

  async capture(sessionName: string, opts?: { lines?: number }): Promise<CaptureResult> {
    const sessionMeta = this.getSessionMeta(sessionName);
    if (sessionMeta.attachmentType === "external_cli") {
      return {
        ok: false,
        sessionName,
        reason: "transport_unavailable",
        error: `Session '${sessionName}' is attached as an external CLI node. Inbound tmux capture is unavailable for this target.`,
      };
    }

    // Classified probe (OPR.0.5.4.2) — same discipline as the send gate: a
    // transport blip is a transport answer, never a dead-seat answer.
    try {
      const probe = await this.tmuxAdapter.probeSession(sessionName);
      if (probe.state === "absent") {
        this.recordSessionMissingVerdict(sessionName);
        return {
          ok: false,
          sessionName,
          reason: "session_missing",
          error: `Session '${sessionName}' not found: tmux reports no session with this name. Nothing was captured. Check available sessions with: rig ps --nodes`,
        };
      }
      if (probe.state === "transport_unavailable") {
        return {
          ok: false,
          sessionName,
          reason: "tmux_unavailable",
          error: `The tmux server could not be reached (${probe.cause}). Whether session '${sessionName}' exists was not determined. Nothing was captured.`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        sessionName,
        reason: "tmux_unavailable",
        error: `The tmux session probe failed unexpectedly (${err instanceof Error ? err.message : String(err)}). Whether session '${sessionName}' exists was not determined. Nothing was captured.`,
      };
    }

    const lines = opts?.lines ?? 20;
    const content = await this.tmuxAdapter.capturePaneContent(sessionName, lines);
    if (content === null) {
      return {
        ok: false,
        sessionName,
        reason: "capture_failed",
        error: `Could not capture pane content for '${sessionName}'.`,
      };
    }

    return { ok: true, sessionName, content, lines };
  }

  async broadcast(target: TargetSpec, text: string, opts?: BroadcastOpts): Promise<BroadcastResult> {
    const resolved = await this.resolveSessions(target);
    if (!resolved.ok) {
      return {
        total: 0,
        sent: 0,
        failed: 0,
        results: [{
          ok: false,
          sessionName: "",
          reason: resolved.code,
          error: resolved.error,
        }],
      };
    }

    // Send/broadcast header (ruling 03c35295): the scope (recipient-scale truth) + the timestamp are
    // computed ONCE per fan-out at send-time — every recipient's header carries the same envelope facts.
    const recipientNames = resolved.sessions.map((s) => s.sessionName);
    const scope = scopeForTarget(target, recipientNames);
    const stampISO = opts?.stampISO ?? new Date().toISOString();
    // GHOST-STAGE (g): resolve the SENDER's occupant generation ONCE per fan-out (same sender for
    // every recipient), at the same seam as stampISO. Local sender ⇒ its atom-B generation-uuid;
    // a cross-host --from relay (sender not a local session) resolves to null ⇒ UNKNOWN ⇒ the
    // render omits the gen suffix (never forges this host's generation onto a foreign sender).
    const genUuid = opts?.envelopeSender
      ? (this.sessionRegistry.currentOccupantGenerationForSession(opts.envelopeSender) ?? undefined)
      : undefined;

    const results: SendResult[] = [];
    for (const session of resolved.sessions) {
      // OPR.0.4.3.30 — per-recipient From/To envelope for `rig send` fan-out, rendered daemon-side (the
      // CLI can't wrap per recipient because it doesn't know each resolved seat). Ruling 03c35295: the
      // To line now projects the SCALE (multi = full list; rig/pod/topology = the broadcast scale) + a
      // Sent stamp, so a recipient tells DM from broadcast header-alone (anti-storm). Raw paths
      // (--raw / --dangerously-interact, absent envelopeSender) still deliver unwrapped.
      const perRecipientText = opts?.envelopeSender
        ? wrapPaneEnvelope(opts.envelopeSender, session.sessionName, text, { scope, stampISO, genUuid })
        : text;
      // (h) thread the resolved stampISO so send()'s delivered-latency calc measures from the SAME
      // compose stamp the envelope carries (opts may not have carried one; the local stampISO is truth).
      const result = await this.send(session.sessionName, perRecipientText, { ...opts, stampISO,
        deliveryId: opts?.deliveryId ? `${opts.deliveryId}:${session.sessionName}` : undefined });
      results.push(result);
    }

    return {
      total: results.length,
      sent: results.filter((r) => r.ok && r.outcome !== "retained").length,
      retained: results.filter(r => r.outcome === "retained").length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }
}
