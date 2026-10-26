import { physicalSessionName } from "./session-registry.js";
import { currentClaudeMcpMenu } from "./claude-mcp-menu.js";
import { currentClaudeResumePicker } from "./native-resume-probe.js";
import stringWidth from "string-width";
import { CODEX_TURN_STATUS_PATTERN } from "./codex-pane-patterns.js";
import { randomUUID } from "node:crypto";
import { COLLAPSED_PASTE, composerRegion, isComposerFooter, isClaudePasteHint, inspectStartupStagedText, QUEUED_PLACEHOLDER, startupSubmissionEvidence, type StartupSubmissionEvidence } from "./startup-submission-evidence.js";
import {
  composerContainsOwnedText,
  composerNumberedChoicePattern,
  composerPromptClassForRuntime,
  composerPromptIsAmbiguous,
  composerSelectionPrefixPattern,
  COMPOSER_DRAFT_PATTERN,
  COMPOSER_EMPTY_CODEX_PLACEHOLDER_PATTERN as CODEX_EMPTY_COMPOSER_PATTERN,
  COMPOSER_EMPTY_PATTERN,
  COMPOSER_PROMPT_CLASS,
  COMPOSER_SELECTION_PATTERN,
  COMPOSER_SELECTION_SCAN_PATTERN,
  findComposerInputLineIndex,
  stripComposerPromptGlyph,
  readComposerPromptLine,
  COMPOSER_COLLAPSED_PASTE_PATTERN,
  type ComposerInput,
  type ComposerSnapshot,
} from "./composer-prompts.js";
export { inspectStartupStagedText } from "./startup-submission-evidence.js";
import { OutboxHandler } from "./outbox-handler.js";
import { DraftAwareDelivery, type GuardedDeliverySummary, type QueueWakeFacts } from "./draft-aware-delivery.js";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import { communityHarnessOf } from "./built-in-runtimes.js";
import { claudeResumeRotation, sessionCommunityHarnessSelect, type SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter, TmuxResult } from "../adapters/tmux.js";
import { newPinHolder, readPinSizing, recordPin, releasePin, WINDOW_SIZE_PRIOR_OPTION, withWindowPin, type PinRelease } from "../terminal/window-pin.js";
import { latestHookPermissionPending, latestHookWaitsOnPerson, type AgentActivityStore } from "./agent-activity-store.js";
import type { EventBus } from "./event-bus.js";
import type { AgentActivity } from "./types.js";
import { DeliveryGuardError, type AdmissionInput, type GuardTarget, type SeatDeliveryGuard } from "./seat-delivery-guard.js";
import { withUrgentLine } from "./urgent-line.js";
import { wrapPaneEnvelope, appendDeliveredSegment, type EnvelopeScope } from "../lib/pane-envelope.js";
import { isBoundTerminalSeat } from "./terminal-seat.js";
import { getSelfHostId } from "./hosts/fanout-contract.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { isShellForeground } from "./shell-classifier.js";
import { observeClaudeDelivery, verifyCodexPaneProcess, type ClaudeDeliveryObservation, type ClaudeResumeRotation, type NativeProcessLister } from "./native-process-lineage.js";
import type { SlowOperationInstrumentation } from "./slow-op-recorder.js";
import { hashSentText, type CaptureObserverSink, type CaptureSlot, type ObservationInput, type ObservedBinding } from "./capture-observer.js";
import { isAttentionRequiredReadinessCode, type NodeBinding, type ReadinessOptions, type ReadinessResult } from "./runtime-adapter.js";
import { getLatestStartupFailedEvent, hasClaudeResumeIdentityWork, isRecoverableStartupFailure } from "./startup-orchestrator.js";

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

// transport.verify_input_box: each extra input-box read gives up after this long and reads `unavailable`. A deadline
// budget, not a guarantee: the pre-Enter read comes after the existing 200 ms wait and can add about this much before
// Enter, and the post-Enter process read about this much before the reply. A read that misses it leaves the send
// unconfirmed, and Enter is still sent once.
const INPUT_BOX_READ_DEADLINE_MS = 500;

// Mid-work detection patterns (cheap heuristics)
const MID_WORK_PATTERNS = [
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, // spinner chars
  /Working/,
  /^[✶✢✳✻✽·]\s+\S.*(?:…|\.{3})\s+\([^)]*\bthinking\)$/m,
  /esc to interrupt/,
  COMPOSER_SELECTION_SCAN_PATTERN,   // trust/consent prompt choices (e.g. '› 1. Yes, continue')
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

const IDLE_PROMPT_PATTERNS = [
  COMPOSER_EMPTY_PATTERN,  // prompt char + optional whitespace + end-of-line only
  CODEX_EMPTY_COMPOSER_PATTERN,
];

const PROMPT_DRAFT_PATTERNS = [
  COMPOSER_DRAFT_PATTERN,
];

// Claude's permission-mode footers: default, accept edits, bypass, auto and plan, optionally after a
// vim-mode marker such as "-- INSERT --" (#808). A suffix such as "· 1 shell" can follow the mode.
const CLAUDE_MODE_FOOTER = /^(?:-- [A-Z]+ -- )?(?:⏵⏵ (?:accept edits|bypass permissions|auto mode) on\b|⏸ plan mode on\b|\? for shortcuts\b)/;

// Sibling pattern identical to CLAUDE_MODE_FOOTER except that it ends in \? for shortcuts$,
// keeping unframed-composer and selectionLines checks anchored on the default footer (#808).
const CLAUDE_ANCHORED_MODE_FOOTER = /^(?:-- [A-Z]+ -- )?(?:⏵⏵ (?:accept edits|bypass permissions|auto mode) on\b|⏸ plan mode on\b|\? for shortcuts$)/;

// Permission mode status footers specifically (excluding shortcuts hint that appears in Codex footers).
const CLAUDE_PERMISSION_MODE_FOOTER = /(?:-- [A-Z]+ -- )?(?:⏵⏵ (?:accept edits|bypass permissions|auto mode) on\b|⏸ plan mode on\b)/;

// Footer hints, not proof of inactivity: Claude also renders its mode bar
// during a turn. Current live-status evidence must take precedence below.
const IDLE_STATUS_BAR_PATTERNS = [
  /gpt-\d[\d.]* .+ · Context \[/,  // Codex model/context footer
  CLAUDE_PERMISSION_MODE_FOOTER,   // Claude Code mode footers (#808)
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
const CLAUDE_QUESTION_FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";

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

const PI_DIALOG_HINTS = [
  /^↑↓ navigate\s+\S.* select\s+\S.* cancel$/,
  /^\S+ submit\s+\S+ cancel$/,
  /^\S+ submit\s+\S+ newline\s+\S+ cancel\s+\S+ external editor$/,
] as const;

/** Adopted Pi TUIs have no runner hooks. Anchor on the selector/input/editor chrome:
 * footer metadata is optional, and an extension can add rows below the dialog. */
function findCurrentPiDialog(paneContent: string): string | null {
  const lines = paneContent.split("\n").map(line => line.trimEnd());
  const visible = lines.flatMap((line, at) => line.trim() ? [{ text: line.trim(), at }] : []);
  const border = (text: string) => /^─{3,}$/.test(text);
  // At most six nonblank footer/widget rows may follow the selector's border.
  for (let help = visible.length - 2; help >= Math.max(1, visible.length - 8); help--) {
    // Text word-wraps the hints. Join at most three adjacent physical rows, not separated prose.
    const rows = (n: number) => visible.slice(help - n + 1, help + 1).map(row => row.text).join(" ");
    const span = [1, 2, 3].find(n => help - n >= 0
      && visible[help]!.at - visible[help - n + 1]!.at === n - 1
      && PI_DIALOG_HINTS.some(pattern => pattern.test(rows(n)))) ?? 1;
    const hint = rows(span);
    const selector = PI_DIALOG_HINTS[0].test(hint);
    const input = PI_DIALOG_HINTS[1].test(hint);
    const editor = PI_DIALOG_HINTS[2].test(hint);
    if (!(selector || input || editor) || !border(visible[help + 1]!.text)) continue;
    // A later editor or closing Markdown fence makes the selector historical/quoted.
    if (visible.slice(help + 2).some(row => border(row.text) || /^(?:`{3,}|~{3,})/.test(row.text))) continue;
    const end = visible[help - span]!.at;
    // Input needs its field and nearby opening rule. Editor's bottom rule and spaced four-action
    // hint remain visible even when its tall body/top rule is outside the 20-line capture.
    if (input && /^>(?:\s|$)/.test(lines[end]!.trim()) && !lines[end - 1]?.trim()
      && lines.slice(Math.max(0, end - PROMPT_SCAN_LINES), end).some(line => border(line.trim()))) return truncateEvidence(hint);
    // ExtensionEditor puts one spacer on either side of the hint; a main-editor draft doesn't.
    if (editor && /^(?:─{3,}|─+ [↑↓] \d+ more ─*)$/.test(lines[end]!.trim())
      && visible[help - span + 1]!.at === end + 2
      && visible[help + 1]!.at === visible[help]!.at + 2) return truncateEvidence(hint);
    if (!selector) continue;
    let start = end;
    // The native spacer before the options separates arbitrary title/description text.
    while (start > Math.max(0, end - PROMPT_SCAN_LINES) && lines[start - 1]!.trim() && !border(lines[start - 1]!.trim())) start--;
    const selected = lines.slice(start, end + 1).map(line => line.trim()).filter(line => /^→ \S/.test(line));
    if (selected.length === 1) return truncateEvidence(selected[0]!);
  }
  return null;
}

function findCurrentClaudeQuestion(paneContent: string): string | null {
  // Claude 2.1.289 can wrap a current choice beyond the general prompt window.
  // Anchor at its terminal footer, then follow only the adjoining choice block.
  // Preserve columns so indented draft/quoted text does not gain new authority.
  const lines = paneContent.split("\n").map(line => line.trimEnd()).filter(line => line.length > 0);
  if (lines.at(-1) !== CLAUDE_QUESTION_FOOTER) return null;
  for (let i = lines.length - 2; i >= 0; i--) {
    const line = lines[i]!;
    if (/^❯ \d+\.\s+\S/.test(line)) return truncateEvidence(line);
    if (!/^(?: {2}\d+\.\s+\S| {5}\S|─{3,}$)/.test(line)) break;
  }
  return null;
}

// Claude can leave these noninteractive warnings BELOW the input box and mode bar.
// Recognize the complete input block, never a warning or historical prompt alone.
const CLAUDE_STATUS_WARNINGS = [
  /^✘ Auto-update failed: no write permission to npm prefix · Run claude doctor$/,
  /^tmux focus-events off · add 'set -g focus-events on' to ~\/\.tmux\.conf and re…$/,
  /^You've used (?:\d|[1-9]\d)% of your weekly limit · resets \d{1,2}(?::\d{2})?(?:am|pm) \(UTC\)$/,
  // #1641: Claude 2.1.293's update banner, whatever installer it names.
  /^Update available! Run: \S.*$/,
  // The context hint, as Claude prints it; reported as the last line below the mode bar on one seat.
  /^new task\? \/clear to save \d+(?:\.\d+)?k tokens$/,
];
// Current Claude status rows need not end in "thinking)" or show "esc to interrupt".
// Completed summaries such as "✻ Crunched for 2s" lack the live ellipsis/timer shape.
// While a hook runs, the timer follows its label: "(running PostToolUse hook · 3m 12s · …)".
const CLAUDE_LIVE_STATUS_PATTERN = /^[✶✢✳✻✽·*]\s+\S[^(]*(?:…|\.{3})\s+\((?:running [^()·]+ hook · )?(?:\d+h\s+)?(?:\d+m\s+)?\d+s\b/;
// The same live row before Claude shows its timer: glyph, text, a trailing ellipsis and nothing
// after it, as in "✻ Compacting conversation…" during a compaction's first seconds. Completed rows
// ("✻ Crunched for 2s") have no trailing ellipsis. Only callers that must not send into a busy
// pane opt in (ClassifyPaneOptions.timerlessStatusIsLive); ordinary send readiness is unchanged.
const CLAUDE_TIMERLESS_STATUS_PATTERN = /^[✶✢✳✻✽·*]\s+\S.*(?:…|\.{3})$/;

export interface ClassifyPaneOptions {
  /** Treat a timer-less live status row above the composer as work in progress. */
  timerlessStatusIsLive?: boolean;
  /** On a fresh Claude running hook, ignore numbered choices from pane history. */
  currentClaudeDialogueOnly?: boolean;
  /** Opted-in typing guards retain styling and cursor evidence for this read. */
  composerSnapshot?: ComposerSnapshot;
  runtime?: string | null;
  /** Only the managed compaction's post-compaction turn boundary: see SendOptions.postCompactTurnBoundary. */
  postCompactTurnBoundary?: boolean;
}

/** The current Claude footer follows the input frame; earlier examples are history or draft text. */
function findClaudeFooterIndex(lines: string[]): number {
  let bar = lines.length - 1;
  while (bar >= 0 && (!lines[bar]!.trim() || CLAUDE_STATUS_WARNINGS.some(pattern => pattern.test(lines[bar]!.trim())))) bar--;
  return bar;
}

// Claude's task-list rows, the only rows it draws between a live status row and the input box. Its renderer marks pending,
// in-progress and completed tasks with figures' small squares and tick (◻ ◼ ✔, or □ ■ √ where the terminal lacks them);
// an older checkbox list used ☐ ☒.
const CLAUDE_TASK_ROW = /^\s*(?:⎿\s+)?[◻◼✔□■√☐☒]\s/;
// Claude's tool and hook output: a "⎿" row, or its continuation indented past that gutter. A reply's own text continues
// two columns in, under its "●".
const CLAUDE_OUTPUT_ROW = /^(?: {2}⎿ | {5,}\S)/;

function findClaudeComposer(paneContent: string, options: ClassifyPaneOptions = {}) {
  // Preserve columns: a multiline draft may contain indented border/prompt text.
  // This classifier scans at most 20 physical lines; captures can be taller.
  // Exhausting the scan without reaching the status head is unknown, not idle.
  // The 20 end at the last drawn row: Claude draws inline, so a short screen in a tall pane leaves its input box above
  // blank rows that the capture keeps.
  const physical = paneContent.split("\n");
  let end = physical.length;
  while (end > 0 && physical[end - 1]!.trim().length === 0) end--;
  const lines = physical.slice(Math.max(0, end - 20), end)
    .map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  const bar = findClaudeFooterIndex(lines);
  const supportedWarningFooter = lines[bar]?.trim() === "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents";
  const modeFooter = CLAUDE_MODE_FOOTER.test(lines[bar]?.trim() ?? "");
  let indent = /^([ \t]*)─{3,}$/.exec(lines[bar - 1] ?? "")?.[1];
  const framed = indent !== undefined;
  let prompt = lines[bar - 2] ?? "";
  let statusStart = bar - 4;
  if (indent === undefined) {
    // The unframed Claude prompt has the same current status/task block.
    // Keep Codex footers and a bare prompt with no visible block on their old path.
    if (bar < 2 || !CLAUDE_ANCHORED_MODE_FOOTER.test(lines[bar]!.trim())) return null;
    prompt = lines[bar - 1] ?? "";
    const input = readComposerPromptLine(prompt, composerPromptClassForRuntime("claude-code"));
    indent = input && !input.text.trim() ? input.indent : undefined;
    if (indent === undefined) return null;
    statusStart = bar - 2;
  } else {
    const upper = lines[bar - 3] ?? "";
    if (!upper.startsWith(indent) || !/^─{3,}(?: .+ ─+)?$/.test(upper.slice(indent.length)) ||
        !prompt.startsWith(`${indent}❯`) || !readComposerPromptLine(prompt, composerPromptClassForRuntime("claude-code"))) return null;
  }

  let liveStatus: string | null = null;
  let headSeen = false;
  let outputOnly = true;
  for (let i = statusStart; i >= 0; i--) {
    if (!lines[i]!.startsWith(indent)) break;
    const line = lines[i]!.slice(indent.length);
    const livePatterns = options.timerlessStatusIsLive
      ? [CLAUDE_LIVE_STATUS_PATTERN, CLAUDE_TIMERLESS_STATUS_PATTERN, ...MID_WORK_PATTERNS]
      : [CLAUDE_LIVE_STATUS_PATTERN, ...MID_WORK_PATTERNS];
    if (livePatterns.some((pattern) => pattern.test(line))) {
      liveStatus = truncateEvidence(line);
      headSeen = true;
      break;
    }
    // Indented task rows can follow the live status. A newer unindented output
    // or completed status ends this block; do not revive an older work row.
    if (!/^\s/.test(line)) { headSeen = true; break; }
    if (CLAUDE_TASK_ROW.test(line) || !CLAUDE_OUTPUT_ROW.test(line)) outputOnly = false;
  }
  return { text: prompt.slice(indent.length), bar: lines[bar]!.trim(), framed, hasWarnings: bar < lines.length - 1, supportedWarningFooter, modeFooter, headSeen, liveStatus, outputOnly };
}

const unknown = (unknownReason: string, cursor?: ComposerSnapshot["cursor"]): ComposerInput => ({ state: "unknown", rows: [], columns: 0, cursorAtEnd: false, collapsedPaste: null, unknownReason, ...(cursor ? { cursor } : {}) });
const rule = (line: string): boolean => /^[─━═-]{6,}(?: .+ [─━═-]+)?$/.test(line.trim());
const codexFooter = (line: string): boolean => isComposerFooter(line)
  || /(?:\b\d+% context left\b|\bContext \[)/.test(line);

/** Preserve faint styling so autocomplete ghosts can be separated from authored
 * text. Color channel values must never be interpreted as style codes. */
function styledTextLines(screen: string) {
  let faint = false;
  return screen.replace(/\r\n/g, "\n").split("\n").map(raw => {
    let text = "", offset = 0;
    const faintCells: boolean[] = [];
    const append = (value: string) => { text += value; faintCells.push(...Array<boolean>(value.length).fill(faint)); };
    for (const match of raw.matchAll(/\x1b\[([0-9;:]*)m/g)) {
      append(raw.slice(offset, match.index));
      const codes = match[1]!.split(";");
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!;
        if (/^(?:38|48|58):/.test(code)) continue; // Colon-form color is one parameter.
        if (code === "38" || code === "48" || code === "58") {
          const skip = codes[i + 1] === "5" ? 2 : codes[i + 1] === "2" ? (codes[i + 2] === "" ? 5 : 4) : 0;
          // Color channels are not style codes. Ambiguous compound sequences
          // provide no faint-style proof, rather than interpreting an RGB 2 as dim.
          if (!skip || i + skip !== codes.length - 1) { faint = false; break; }
          i += skip;
        } else if (code === "" || code === "0" || code === "22") faint = false;
        else if (code === "2") faint = true;
      }
      offset = match.index! + match[0].length;
    }
    append(raw.slice(offset));
    return { text, faintCells };
  });
}

/** Inspect only the visible input containing the current cursor. Activity, hook
 * freshness and text elsewhere in the pane are not evidence that input is empty.
 */
export function inspectComposerInput(snapshot: ComposerSnapshot | null, runtime: string | null = null, owned?: import("./composer-prompts.js").ComposerOwnership): ComposerInput {
  const promptClass = composerPromptClassForRuntime(runtime);
  if (!snapshot) return unknown("capture_unavailable");
  if (snapshot.inMode) return unknown("pane_in_mode", snapshot.cursor);
  const { x, y, width, height } = snapshot.cursor;
  if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || x >= width || y >= height || width < 3 || height < 1) return unknown("invalid_cursor", snapshot.cursor);
  const styled = styledTextLines(snapshot.screen);
  const lines = styled.map(line => line.text);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > height || !lines[y]) return unknown("incomplete_frame", snapshot.cursor);
  const footerAt = findClaudeFooterIndex(lines);
  const footer = lines[footerAt]?.trim() ?? "";
  let claudeEnd = footerAt - 1;
  while (claudeEnd >= 0 && !lines[claudeEnd]!.trim()) claudeEnd--;
  const candidates: ComposerInput[] = [];
  for (let start = 0; start <= y; start++) {
    const prompt = readComposerPromptLine(lines[start] ?? "", promptClass);
    if (!prompt || !/^ *$/.test(prompt.indent)) continue;
    const numbered = composerSelectionPrefixPattern(promptClass).test(lines[start]!.trimStart()) || /^\d+[.)]\s/.test(prompt.text);
    const prefix = prompt.prefix;
    let end = -1;
    if (prompt.glyph === "❯") {
      // Share the main reader's terminal footer anchor. A quoted frame within a
      // multiline draft cannot supply either the closing rule or its indentation.
      const alignedRule = (line: string) => rule(line) && line.length - line.trimStart().length === prompt.indent.length;
      if ((!isComposerFooter(footer) && !CLAUDE_MODE_FOOTER.test(footer))
        || !alignedRule(lines[start - 1] ?? "") || !alignedRule(lines[claudeEnd] ?? "")) continue;
      end = claudeEnd;
    } else {
      for (let i = start + 1; i < lines.length; i++) {
        if (lines[i]!.trim()) continue;
        const tail = lines.slice(i + 1).filter(line => line.trim());
        if (lines[i + 1]?.trim() && tail.length === 1 && codexFooter(tail[0]!.trim())) { end = i; break; }
      }
    }
    if (end <= y || x < prefix) continue;
    const rows = [prompt.text];
    let valid = true;
    for (let i = start + 1; i < end; i++) {
      const line = lines[i]!;
      if (line.trim() && !line.startsWith(" ".repeat(prefix))) { valid = false; break; }
      rows.push(line.slice(prefix));
    }
    if (!valid) continue;
    // A suggestion is a wholly dim suffix beginning at the current cursor.
    // A literal placeholder or text before a moved cursor remains authored input.
    const cursorRow = y - start;
    let ghost: ComposerInput["ghost"];
    let suggestionRows: string[] = [];
    const currentRow = rows[cursorRow]!;
    let cursorOffset = x === prefix ? 0 : -1;
    let offset = 0;
    for (const character of currentRow) {
      offset += character.length;
      if (stringWidth(currentRow.slice(0, offset)) === x - prefix) cursorOffset = offset;
    }
    if (cursorOffset >= 0) {
      const suffix = rows.slice(cursorRow).map((row, i) => ({
        text: row.slice(i === 0 ? cursorOffset : 0),
        faint: styled[y + i]!.faintCells.slice(prefix + (i === 0 ? cursorOffset : 0), prefix + row.length),
      }));
      if (suffix.some(row => row.text.length > 0) && suffix.every(row => row.faint.every(Boolean))) {
        suggestionRows = suffix.map(row => row.text);
        ghost = { line: y, offset: prefix + cursorOffset, continuationRows: rows.length - cursorRow - 1 };
        rows.splice(cursorRow + 1);
        rows[cursorRow] = currentRow.slice(0, cursorOffset);
      }
    }
    const visible = rows.map(line => line.trimEnd());
    // The cursor bounds authored whitespace on the last input row. Captures may
    // omit trailing blank cells or include screen padding; neither changes the bytes to submit.
    if (cursorRow === rows.length - 1) {
      const cellWidth = stringWidth(rows[cursorRow]!);
      if (x - prefix >= cellWidth) visible[cursorRow] = rows[cursorRow]! + " ".repeat(x - prefix - cellWidth);
      else if (cursorOffset >= 0 && !rows[cursorRow]!.slice(cursorOffset).trim()) visible[cursorRow] = rows[cursorRow]!.slice(0, cursorOffset);
    }
    const atStart = y === start && x === prefix;
    const empty = atStart && rows.length === 1 && rows[0] === "";
    const last = visible.length - 1;
    const cursorAtEnd = y === start + last && x === prefix + stringWidth(visible[last] ?? "");
    const label = visible.length === 1 && COMPOSER_COLLAPSED_PASTE_PATTERN.test(visible[0]!) ? visible[0]! : null;
    // Claude replaces its mode hint after our paste; that noninteractive hint is not a new composer.
    const stableFooter = prompt.glyph === "❯" && (CLAUDE_MODE_FOOTER.test(footer) || isClaudePasteHint(footer)) ? "claude-composer" : footer;
    const frame = JSON.stringify([prompt.glyph, prefix, width, stableFooter]);
    const input: ComposerInput = { state: empty ? "empty" : "text", cursor: { ...snapshot.cursor }, suggestionRows, rows: visible, columns: width - prefix, cursorAtEnd, collapsedPaste: label, frame,
      ...(ghost ? { ghost } : {}) };
    // A numbered body is allowed only as this operation's exact text in its
    // previously empty composer. A newly observed menu gains no such authority.
    if (numbered && !(owned?.frame === frame && composerContainsOwnedText(input, owned.text))) continue;
    if (owned?.frame === frame && cursorAtEnd && visible.join("\n").includes("[Pasted text #")
      && hasExpectedStagedText(`${prompt.glyph} ${visible.join("\n")}`, owned.text, runtime)) {
      input.collapsedPaste = visible.join("\n");
      input.pasteMatchesExpected = true;
    }
    candidates.push(input);
  }
  return candidates.length === 1 ? candidates[0]! : unknown(candidates.length ? "ambiguous_composer" : "unrecognized_composer", snapshot.cursor);
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
  const prompt = readComposerPromptLine(priorLine);
  const looksLikeDraft = prompt !== null && prompt.text.trim().length > 0;
  const looksLikeSelection = COMPOSER_SELECTION_PATTERN.test(priorTrimmed);
  if (!looksLikeDraft || looksLikeSelection) return null;

  return truncateEvidence(priorTrimmed);
}

type StyledCell = { ch: string; faint: boolean };

/** A capture taken with escape sequences, as lines of cells that know whether they're faint (SGR 2).
 *  Color parameters (38/48/58 with 5;n or 2;r;g;b) are skipped, so a color value of 2 isn't faint.
 *  Other escape sequences carry no text. */
function styledLines(styledPane: string): StyledCell[][] {
  let faint = false;
  return styledPane.replace(/\r\n/g, "\n").split("\n").map((raw) => {
    const cells: StyledCell[] = [];
    let offset = 0;
    for (const match of raw.matchAll(/\x1b\[([0-9;:?]*)[ -\/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g)) {
      for (const ch of raw.slice(offset, match.index)) cells.push({ ch, faint });
      offset = match.index! + match[0].length;
      if (match[2] !== "m") continue;
      const codes = match[1]!.split(";");
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!;
        if (code === "38" || code === "48" || code === "58") { i += codes[i + 1] === "5" ? 2 : codes[i + 1] === "2" ? 4 : 0; continue; }
        if (code === "2") faint = true;
        else if (code === "" || code === "0" || code === "22") faint = false;
      }
    }
    for (const ch of raw.slice(offset)) cells.push({ ch, faint });
    return cells;
  });
}

/** The last line that starts with a prompt glyph (`❯` or `›`), or -1. */
function lastPromptLine(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*[❯›]/.test(lines[i]!)) return i;
  return -1;
}

/** True only when the last prompt line has text and all of it is faint, as Claude renders its
 *  suggestion. An empty last prompt, or a capture without escape sequences, never proves faint. */
export function promptTextIsFaint(styledPane: string): boolean {
  const lines = styledLines(styledPane);
  const last = lastPromptLine(lines.map((cells) => cells.map((cell) => cell.ch).join("")));
  if (last < 0) return false;
  const glyph = lines[last]!.findIndex((cell) => cell.ch === "❯" || cell.ch === "›");
  const text = lines[last]!.slice(glyph + 1).filter((cell) => !/\s/.test(cell.ch));
  return text.length > 0 && text.every((cell) => cell.faint);
}

/** Classifies one Claude capture taken with escape sequences, as a single frame. `suggestion` is set
 *  only when that frame's own draft is its last prompt line and all of that text is faint: it's then
 *  the frame classified as an empty composer. */
export function classifyStyledFrame(styledPane: string, options: ClassifyPaneOptions = {}): { frame: string; asIs: PaneActivityClassification; composer: string | null; suggestion: PaneActivityClassification | null } {
  const lines = styledLines(styledPane).map((cells) => cells.map((cell) => cell.ch).join(""));
  const frame = lines.join("\n");
  const asIs = classifyPaneActivity(frame, options);
  const composer = draftComposerLine(lines, asIs);
  if (composer === null || !promptTextIsFaint(styledPane)) return { frame, asIs, composer, suggestion: null };
  const last = lastPromptLine(lines);
  lines[last] = /^\s*[❯›]/.exec(lines[last]!)![0];
  return { frame, asIs, composer, suggestion: classifyPaneActivity(lines.join("\n"), options) };
}

/** The full text of the line a `prompt_draft` verdict read as the draft, when that's the last prompt
 *  line; otherwise null. Evidence is compacted and truncated, so callers compare this instead. */
function draftComposerLine(lines: string[], verdict: PaneActivityClassification): string | null {
  const last = lastPromptLine(lines);
  if (verdict.reason !== "prompt_draft" || last < 0 || verdict.evidence !== truncateEvidence(lines[last]!)) return null;
  return lines[last]!.trim();
}

const OPENCLAW_TURN_NOT_RECOVERED = "OpenClaw turn not recovered; inspect the pane before retrying";

/** The pinned OpenClaw local error frame, not a quoted error in history or a recovery-state diagnosis.
 * Multiple native branches emit the same refusal; observe it without touching native session state. */
function currentOpenClawTurnRefusal(paneContent: string): string | null {
  const lines = trimPaneLines(styledTextLines(paneContent).map(line => line.text).join("\n"));
  const editorRules = lines.flatMap((line, at) => /^─{3,}$/.test(line) ? [at] : []);
  // The pinned TUI puts its status/footer above the editor. Extra rules make that boundary ambiguous;
  // leave those layouts unclassified rather than selecting a quoted frame inside the composer.
  if (editorRules.length !== 2 || editorRules[1] !== lines.length - 1) return null;
  for (let at = editorRules[0]! - 1; at >= 0; at--) {
    if (!/^(?:local|gateway)\s+.*\|/.test(lines[at]!)) continue;
    if (lines[at]!.replace(/\s+/g, " ") !== "local ready | error"
      || !lines[at + 1]?.startsWith("agent main | session ")) return null;
    const error = lines.slice(Math.max(0, at - 12), at).join(" ");
    const match = /(?:^| )run error:\s*Session\s+"[^"]+"\s+changed while\s+starting work\.\s+Retry\.$/.exec(error);
    return match ? truncateEvidence(match[0]) : null;
  }
  return null;
}

/** A community harness's screen never proves it's idle: a quiet prompt can be an approval or a pause, so its idle
 *  reading becomes unknown. Positive work and attention are kept. `communityHarness` is the seat's recorded selection
 *  (`communityHarnessOf`); without it the classification is returned as it is. */
export function communityHarnessPaneActivity(classification: PaneActivityClassification, communityHarness: string | null | undefined, paneContent = ""): PaneActivityClassification {
  const refused = communityHarness === "openclaw" ? currentOpenClawTurnRefusal(paneContent) : null;
  if (refused) return { state: "attention", reason: OPENCLAW_TURN_NOT_RECOVERED, evidence: refused };
  return communityHarness && classification.state === "agent_idle"
    ? { state: "unknown", reason: "community_harness_no_idle_signal", evidence: classification.evidence }
    : classification;
}

export function classifyPaneActivity(paneContent: string, options: ClassifyPaneOptions = {}): PaneActivityClassification {
  if (options.composerSnapshot) {
    const snapshot = options.composerSnapshot;
    const { ghost } = inspectComposerInput(snapshot, options.runtime);
    const lines = styledTextLines(snapshot.screen).map(line => line.text);
    if (ghost) {
      lines[ghost.line] = lines[ghost.line]!.slice(0, ghost.offset);
      lines.splice(ghost.line + 1, ghost.continuationRows);
    }
    paneContent = lines.join("\n");
  }
  const lastNonBlank = trimPaneLines(paneContent);
  if (lastNonBlank.length === 0) {
    return { state: "unknown", reason: "empty_capture", evidence: null };
  }

  const piConfirmation = findCurrentPiDialog(paneContent);
  if (piConfirmation) return { state: "attention", reason: "selection_prompt", evidence: piConfirmation };

  const recentLines = lastNonBlank.slice(-8);
  const claudeComposer = findClaudeComposer(paneContent, options);
  // Claude's own timer row above its complete, empty input box means the turn is running, not waiting at a dialogue,
  // so for a Claude read, prompt-looking text above that box is quoted output or history. Only the timer row counts,
  // never a selector-shaped "mid-work" line. A prompt drawn above the box shows no timer row, so it's still caught.
  // This rests on where Claude draws a dialogue. A native check on Claude Code 2.1.309 saw the MCP menu, a Read
  // permission and AskUserQuestion each replace the input box, including with two Read calls issued in parallel, and
  // never drawn beside a timer row. That covers the layouts exercised, not every Claude version.
  const historyAboveInput = options.runtime === "claude-code" && claudeComposer?.framed === true &&
    CLAUDE_ANCHORED_MODE_FOOTER.test(claudeComposer.bar) && IDLE_PROMPT_PATTERNS.some(pattern => pattern.test(claudeComposer.text)) &&
    !!claudeComposer.liveStatus && CLAUDE_LIVE_STATUS_PATTERN.test(claudeComposer.liveStatus);
  // Wider window for prompt SIGNATURES so a tall footer can't push a real prompt out of view (see
  // PROMPT_SCAN_LINES). The generic activity checks below keep the tighter 8-line window.
  const promptScanLines = historyAboveInput ? [] : lastNonBlank.slice(-PROMPT_SCAN_LINES);
  const trailingNonBlank = lastNonBlank.slice(-3);
  const lastLine = lastNonBlank.at(-1) ?? "";
  const idlePromptLine = trailingNonBlank.find((line) =>
    IDLE_PROMPT_PATTERNS.some((pattern) => pattern.test(line))
  );
  const idleStatusBarLine = IDLE_STATUS_BAR_PATTERNS.some((pattern) => pattern.test(lastLine))
    ? lastLine
    : null;
  const oldQuestionEnd = promptScanLines.lastIndexOf(CLAUDE_QUESTION_FOOTER);
  const permissionPromptEvidence = findPatternEvidence(promptScanLines, PERMISSION_PROMPT_PATTERNS);
  // A complete later empty composer with a recognized Claude bar makes the preceding question history.
  // Keep draft handling and selectors without this dialog boundary unchanged.
  const selectionLines = claudeComposer?.framed &&
      CLAUDE_ANCHORED_MODE_FOOTER.test(claudeComposer.bar) &&
      IDLE_PROMPT_PATTERNS.some(pattern => pattern.test(claudeComposer.text)) &&
      oldQuestionEnd >= 0 && oldQuestionEnd < promptScanLines.length - 1
    ? promptScanLines.slice(oldQuestionEnd + 1)
    : options.runtime === "codex" && !permissionPromptEvidence
      ? codexCurrentSelectionLines(paneContent) ?? promptScanLines : promptScanLines;
  const currentComposer = options.currentClaudeDialogueOnly && options.runtime === "claude-code"
    ? composerRegion(paneContent, "claude-code")
    : null;
  const currentComposerText = currentComposer?.body ?? (currentComposer?.markerLine !== null && currentComposer?.markerLine !== undefined
    && currentComposer.closingRuleLine !== null && currentComposer.closingRuleLine !== undefined
    ? paneContent.split(/\r?\n/).slice(currentComposer.markerLine - 1, currentComposer.closingRuleLine - 1).join("\n")
    : null);
  const currentComposerSelection = currentComposerText
    ? findPatternEvidence(currentComposerText.split("\n").map(line => line.trimStart()), [COMPOSER_SELECTION_SCAN_PATTERN])
    : null;
  // Claude's resume picker types a paste into its search and resumes a card on Enter. A Codex or Pi pane printing one is output.
  const claudePicker = options.runtime === "codex" || options.runtime === "pi" ? null : currentClaudeResumePicker(paneContent);
  const selectionPromptEvidence = claudePicker ?? currentClaudeMcpMenu(paneContent) ?? findCurrentClaudeQuestion(paneContent) ??
    currentComposerSelection ?? (options.currentClaudeDialogueOnly ? null
      : findPatternEvidence(selectionLines, [COMPOSER_SELECTION_SCAN_PATTERN]));
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
  if (permissionPromptEvidence) {
    return {
      state: "attention",
      reason: "permission_prompt",
      evidence: permissionPromptEvidence,
    };
  }

  if (claudeComposer?.hasWarnings && claudeComposer.supportedWarningFooter && PROMPT_DRAFT_PATTERNS.some((pattern) => pattern.test(claudeComposer.text))) {
    return { state: "attention", reason: "prompt_draft", evidence: truncateEvidence(claudeComposer.text) };
  }
  if (claudeComposer?.liveStatus) {
    return { state: "agent_active", reason: "mid_work_pattern", evidence: claudeComposer.liveStatus };
  }
  // Right after a managed compaction the rows above the input box are indented compaction and hook output, so the status
  // head is out of this window and the read stays unknown until the screen changes. For that one send, a complete framed
  // empty box with its mode footer, and no live status in view, is idle, but only while every row above it is that output.
  // A tall task list can push a live status out of the window, and Claude hides its status while it streams a reply, so
  // task rows or reply text in view may be a seat that is working.
  const postCompactEmptyBox = options.postCompactTurnBoundary === true && claudeComposer?.framed === true &&
    claudeComposer.modeFooter && claudeComposer.outputOnly && IDLE_PROMPT_PATTERNS.some((pattern) => pattern.test(claudeComposer.text));
  // Unframed status evidence can veto idle, but warnings require a complete input frame to prove it.
  if (claudeComposer && !postCompactEmptyBox && (!claudeComposer.headSeen || (claudeComposer.hasWarnings && !claudeComposer.framed))) {
    return { state: "unknown", reason: "no_activity_signal", evidence: truncateEvidence(lastLine) };
  }
  // An empty prompt row is not an empty box: authored text can start on a continuation row.
  // Read the same bounded composer region as the input check before a mode footer can imply idle.
  const inputBox = options.runtime !== "codex" ? composerRegion(paneContent, "claude-code") : null;
  if (inputBox?.body && inputBox.markerLine !== null &&
      /^\s*❯\s*$/.test(paneContent.split("\n")[inputBox.markerLine - 1]!)) {
    return { state: "unknown", reason: "no_activity_signal", evidence: truncateEvidence(lastLine) };
  }
  // Below warning rows, any Claude mode footer completes the frame for an EMPTY composer (#808).
  // Drafts keep the narrower check above: attention is needs_input, a send refusal for other modes.
  if (claudeComposer && (!claudeComposer.hasWarnings || claudeComposer.modeFooter) &&
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

  const midWorkEvidence = findPatternEvidence(recentLines, [
    ...MID_WORK_PATTERNS,
    CLAUDE_LIVE_STATUS_PATTERN,
    ...(options.timerlessStatusIsLive ? [CLAUDE_TIMERLESS_STATUS_PATTERN] : []),
  ]);
  const isClaudeStatusBar = CLAUDE_PERMISSION_MODE_FOOTER.test(idleStatusBarLine ?? "");
  if (idleStatusBarLine && (!isClaudeStatusBar || !midWorkEvidence)) {
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
  /** See ClassifyPaneOptions.timerlessStatusIsLive. */
  timerlessStatusIsLive?: boolean;
  visibleScreenOnly?: boolean;
  /** Limit numbered-choice detection to current Claude dialogue and composer evidence. */
  currentClaudeDialogueOnly?: boolean;
  /** Supplied only by an active draft-aware send; ordinary observations stay unchanged. */
  composerSnapshot?: () => Promise<ComposerSnapshot | null>;
  /** The seat's community harness (`communityHarnessOf`): its idle-looking screen reads unknown. */
  communityHarness?: string | null;
  /** Ordinary sends keep existing community idle readings; an OpenClaw turn error is advisory, not a picker. */
  communityHarnessSendProbe?: boolean;
  /** See ClassifyPaneOptions.postCompactTurnBoundary. */
  postCompactTurnBoundary?: boolean;
}): Promise<AgentActivity> {
  // Capture routing and observation labels must share the entry context. The
  // caller may reuse/mutate its input while hasSession is pending.
  const { sessionName, runtime, attachmentType, tmuxAdapter, now, captureObserver, binding, visibleScreenOnly } = input;
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
  const readTarget = binding?.pane ?? sessionName;
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
      const paneCommand = await tmuxAdapter.getPaneCommand(readTarget);
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
    const capture = (opts?: { escapeSequences?: boolean }) => visibleScreenOnly
      ? opts ? tmuxAdapter.capturePaneScreen(readTarget, opts) : tmuxAdapter.capturePaneScreen(readTarget)
      : opts ? tmuxAdapter.capturePaneContent(readTarget, 20, opts) : tmuxAdapter.capturePaneContent(readTarget, 20);
    const snapshot = input.composerSnapshot ? await input.composerSnapshot().catch(() => null) : null;
    const paneContent = snapshot?.screen ?? await capture();
    const capturedAt = new Date().toISOString();
    const classifyOptions = {
      timerlessStatusIsLive: input.timerlessStatusIsLive === true,
      currentClaudeDialogueOnly: input.currentClaudeDialogueOnly === true,
      postCompactTurnBoundary: input.postCompactTurnBoundary === true,
    };
    const paneClassification = classifyPaneActivity(paneContent ?? "", { ...classifyOptions,
      composerSnapshot: snapshot ?? undefined, runtime });
    let classification = communityHarnessPaneActivity(paneClassification, input.communityHarness, paneContent ?? "");
    if (input.communityHarnessSendProbe) {
      if (classification.reason === "community_harness_no_idle_signal") classification = paneClassification;
      else if (classification.reason === OPENCLAW_TURN_NOT_RECOVERED) classification = { ...classification, state: "unknown" };
    }
    // Claude renders its prompt suggestion faint, which the plain capture loses. When a Claude pane reads
    // as a draft, one capture with styling is classified on its own. Newer attention or work there is
    // kept. A faint suggestion counts only when it's the same composer text this capture read as a draft;
    // the verdict is then the styled frame's, as an empty composer. Anything else leaves the draft standing.
    let slot = captureSlot(paneContent, capturedAt, captureSeq);
    if (classification.reason === "prompt_draft" && runtime === "claude-code" && paneContent) {
      const styled = await capture({ escapeSequences: true }).catch(() => null);
      const later = styled ? classifyStyledFrame(styled, classifyOptions) : null;
      const newer = !later ? null
        : later.asIs.state === "agent_active" || (later.asIs.state === "attention" && later.asIs.reason !== "prompt_draft") ? later.asIs
        : later.suggestion && later.composer === draftComposerLine(paneContent.split("\n"), classification) ? later.suggestion
        : null;
      if (later && newer) {
        classification = newer;
        slot = captureSlot(later.frame, new Date().toISOString(), captureSeq);
      }
    }
    return observeProbe(slot, {
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

/**
 * Claude indents continuation lines in submitted prompts. Compare the same
 * line content in the sent text and both captures, retaining line breaks and
 * within-line spacing rather than allowing unrelated words to match.
 */
function normalizeVerificationText(text: string): string {
  return text.replace(/\r?\n[ \t]*/g, "\n");
}

/** Match the full envelope with whitespace collapsed, including body and recipient.
 * Raw sends retain their normalized 40-character prefix and spacing. */
function verificationSnippet(text: string): { snippet: string; envelope: boolean } {
  const normalized = normalizeVerificationText(text);
  const header = /^From: [^\n]+\nTo: [^\n]+\n(?:Sent: [^\n]+\n)?---\n/.exec(normalized);
  return { snippet: header ? normalized.replace(/\s+/g, " ").trim() : normalized.slice(0, 40), envelope: !!header };
}

/** Count whole visible envelope blocks, not prefixes of longer messages.
 * A new envelope, prompt or same-column output ends an indented user block.
 * Whitespace is compared only after retaining boundaries and quote indentation. */
function countEnvelopeOccurrences(transcript: string, expected: string, promptClass: string): number {
  const promptPrefix = new RegExp(`^[${promptClass}]\\s+`);
  const promptBoundary = new RegExp(`^[${promptClass}](?:\\s|$)`);
  const lines = transcript.split("\n");
  let count = 0;
  let block: string[] | null = null;
  let blockIndent = 0;
  let blockPrompted = false;
  let inAgentOutput = false;
  const finish = () => {
    if (block?.join("\n").replace(/\s+/g, " ").trim() === expected) count++;
    block = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const indent = /^[ \t]*/.exec(line)![0].length;
    const prompted = promptPrefix.test(line.slice(indent));
    const header = line.slice(indent).replace(promptPrefix, "");
    const atBoundary = (!block && !inAgentOutput) || indent <= blockIndent;
    const candidate = normalizeVerificationText([header, ...lines.slice(i + 1, i + 5)].join("\n"));
    const envelopeHeader = /^From: [^\n]+\nTo: [^\n]+\n(?:Sent: [^\n]+\n)?---\n/.test(candidate);
    if (atBoundary && envelopeHeader && (!inAgentOutput || prompted)) {
      finish();
      block = [header];
      blockIndent = indent;
      // Flat historical captures have no role columns; retain whole-block
      // equality there instead of treating their own header/body as output.
      blockPrompted = prompted && /^[ \t]*/.exec(lines[i + 1] ?? "")![0].length > indent;
      inAgentOutput = false;
    } else if (atBoundary && blockPrompted && line.trim().length > 0) {
      // Any nonblank boundary line is outside an indented user block. Deeper
      // quotes stay in the body, and blank separators do not change its text.
      finish();
      inAgentOutput = true;
    } else if (atBoundary && promptBoundary.test(line.slice(indent))) {
      finish();
    } else if (block) {
      block.push(line);
    }
  }
  finish();
  return count;
}

/** The last prompt marker owns the current input region. Never count it or its
 * continuation lines as submitted transcript, in either capture. If a capture
 * ends at a historical prompt with no later input marker, leave it unconfirmed. */
function verificationTranscript(content: string | null, promptClass: string): string {
  const indentedPrompt = new RegExp(`^([ \\t]*)[${promptClass}]`);
  const lines = (content ?? "").replace(/\r\n/g, "\n").split("\n");
  let inputAt = findComposerInputLineIndex(lines, promptClass);
  if (inputAt >= 0) {
    let indent = /^[ \t]*/.exec(lines[inputAt]!)![0].length;
    // Claude indents draft continuation lines. A quoted prompt on one of them
    // belongs to the enclosing input, not a new transcript/composer boundary.
    for (let i = inputAt - 1; i >= 0; i--) {
      const prompt = indentedPrompt.exec(lines[i]!);
      if (prompt && prompt[1]!.length < indent) {
        inputAt = i;
        indent = prompt[1]!.length;
      }
    }
  }
  // A visible framed composer starts at its upper rule, not its prompt.
  // Keep quoted/indented rules in the message; require a matching lower frame.
  if (inputAt > 0) {
    const indent = /^[ \t]*/.exec(lines[inputAt]!)![0];
    const frame = (line: string) => line.startsWith(indent) &&
      /^─{3,}(?: .+ ─+)?$/.test(line.slice(indent.length).trimEnd());
    if (frame(lines[inputAt - 1]!) && lines.slice(inputAt + 1).some(frame)) inputAt--;
  }
  return (inputAt < 0 ? lines : lines.slice(0, inputAt)).join("\n");
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
export function hasExpectedStagedText(pane: string | null, expected: string, runtime: string | null = null): boolean {
  const norm = (s: string) => s.replace(/\s+/g, "");
  // The composer glyph set is scoped to the runtime when known: a Claude draft's
  // continuation line can start with a Codex glyph, and taking that line as the
  // input marker would misread the staged text. Unknown runtimes keep the union.
  const promptClass = composerPromptClassForRuntime(runtime);
  // Round-2 (r2 HIGH-1): the evidence must be the CURRENT ACTIVE INPUT and must identify
  // THIS piece — stale scrollback can carry an old placeholder while a LATER interactive
  // prompt owns the input, and an Enter there approves the prompt. So:
  //   1. Only the pane's LAST input-marker line counts (the current input; everything above
  //      is history).
  //   2. A numbered-option line (`❯ 1. …`, `› 1.Yes`) is a PROMPT SELECTION, never staged
  //      input: refuse.
  //   3. A pasted-text placeholder is identity-qualified: "[Pasted text #N +X lines]" counts
  //      only when X matches the expected piece's own line count (±1 for a trailing newline).
  //      More than one placeholder is COALESCED staging (several pieces, one Enter): refuse.
  //   4. Otherwise the line must carry the content's own head (24 normalized chars — a short
  //      paste renders inline, possibly truncated).
  const paneLines = (pane ?? "").split("\n");
  const currentInputAt = findComposerInputLineIndex(paneLines, promptClass);
  let stagedEvidence = false;
  if (currentInputAt >= 0) {
    // Unknown runtime: a composer block that mixes glyph kinds has no runtime to
    // say which line is live, so fail closed exactly as the pre-union check did.
    if (composerPromptIsAmbiguous(paneLines, currentInputAt, promptClass)) return false;
    const inputLine = paneLines[currentInputAt]!.trimStart();
    // The region is the last composer-marker line through the input box's closing separator
    // (a box-drawing line) or pane end — wrapped input continues below the marker; everything
    // ABOVE the marker is history and everything below the separator is hint-bar chrome.
    let regionEnd = paneLines.length;
    for (let i = currentInputAt + 1; i < paneLines.length; i++) {
      const t = paneLines[i]!.trim();
      if (t.length >= 10 && /^[─═-]+$/.test(t)) { regionEnd = i; break; }
    }
    const region = paneLines.slice(currentInputAt, regionEnd).join("\n");
    if (!composerSelectionPrefixPattern(promptClass).test(inputLine)) {
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
        const residual = stripComposerPromptGlyph(norm(regionFlat.replace(placeholderRe, "").replace(chrome, "")), promptClass);
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
  // Fail closed for an unknown runtime: with no scoped glyph set there is no way to
  // say which prompt line is the live input (the pre-shared-matcher check did the same).
  if (runtime !== "codex" && runtime !== "claude-code") return false;
  const promptClass = composerPromptClassForRuntime(runtime);
  const lines = pane.split("\n");
  // Only the LAST prompt line of this runtime's glyph set can be the current input;
  // everything above it is transcript history, and another harness's glyph is not ours.
  const inputIndex = findComposerInputLineIndex(lines, promptClass);
  if (inputIndex < 0) return false;
  const input = lines[inputIndex]!.trimStart();
  // A numbered choice (`.` or `)`), e.g. `» 1)` or `❯ 1.`, is a menu selection, never the answer.
  if (composerNumberedChoicePattern(promptClass).test(input)) return false;
  // Where the input ends: Codex closes the composer on a blank line, Claude Code on a rule line.
  const end = lines.findIndex((line, index) => index > inputIndex && (runtime === "codex"
    ? line.trim() === "" : /^[─═-]{10,}$/.test(line.trim())));
  return end > inputIndex && lines.slice(inputIndex, end).join("\n").trimStart().slice(1).trim() === answer.trim();
}

// Codex 0.160 input box: the last prompt line plus indented continuation rows, one blank row, then a footer
// of at most two rows: the `<model> · <~ or /path>` status line, optionally followed by one known hint row.
const CODEX_STATUS_LINE = /^ {2}[^\s·][^·]* · [~/]/;
const CODEX_HINT_ROW = /(?:^|\s)\? for shortcuts(?:\s|$)|⚠ \d+ warnings? · f2 to view\s*$/;
// Codex shows a long paste as this label until it is submitted. Matched on the normalized body.
const CODEX_COLLAPSED_PASTE = /^\[PastedContent\d+chars\]$/;

/** The current Codex input box: its normalized text ("" when empty), its rows as drawn (the prompt glyph removed)
 *  and where its prompt row is, or null when the layout is not the recognized one (another footer, a selector, no
 *  blank separator, an older TUI). */
function codexInputBox(pane: string): { text: string; rows: string[]; lines: string[]; inputAt: number } | null {
  const lines = pane.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]!.trim()) last--;
  let footerStart = last;
  while (footerStart > 0 && lines[footerStart - 1]!.trim()) footerStart--;
  const footer = lines.slice(footerStart, last + 1);
  if (last < 0 || footer.length > 2 || !CODEX_STATUS_LINE.test(footer[0]!)
    || !footer.slice(1).every((row) => CODEX_HINT_ROW.test(row))) return null;
  // promptAnswerStaged also ends a Codex input at a blank row.
  const separator = footerStart - 1;
  if (separator < 1 || lines[separator]!.trim()) return null;
  const promptClass = composerPromptClassForRuntime("codex");
  const inputAt = findComposerInputLineIndex(lines.slice(0, separator), promptClass);
  if (inputAt < 0 || composerNumberedChoicePattern(promptClass).test(lines[inputAt]!.trimStart())) return null;
  const rows = lines.slice(inputAt, separator);
  // Only indented continuation rows belong to the input; anything else is not an input box.
  if (rows.slice(1).some((row) => row.trim() && !/^\s/.test(row))) return null;
  if (CODEX_EMPTY_COMPOSER_PATTERN.test(rows[0]!.trimStart()) && rows.slice(1).every((row) => !row.trim())) {
    return { text: "", rows: [], lines, inputAt };
  }
  return { text: rows.join("\n").trimStart().slice(1).replace(/\s+/g, ""), rows: stripBoxGlyph(rows), lines, inputAt };
}

/** A box's rows with the prompt glyph taken off the first row (`❯`, `›`), as composerRegion does for its body. */
function stripBoxGlyph(rows: string[]): string[] {
  return rows.map((row, i) => (i === 0 ? row.trimStart().slice(1) : row));
}

// Bounds of a string's terminal width. Upper: a non-ASCII character may take two cells. Lower: a printable ASCII
// character takes exactly one cell, and any other character is counted as none (a combining mark, a variation
// selector or a joiner takes none, and an emoji sequence of several code points takes two cells in all).
const widthAtMost = (text: string) => [...text].reduce((cells, ch) => cells + (ch.charCodeAt(0) < 0x80 ? 1 : 2), 0);
const widthAtLeast = (text: string) => [...text].filter((ch) => ch >= " " && ch <= "~").length;

// Pairs of characters that no wrapper separates across rows inside a word that fits in a row, under the conditions
// rowBreakIsSpace adds. Claude Code 2.1.296 wraps its input with wrap-ansi, which breaks only at spaces. Codex 0.160.0
// wraps it with textwrap's FirstFit, its UAX #14 word separator and its hyphen splitter, then re-passes the rows
// (tui/src/bottom_pane/textarea/wrapping.rs at rust-v0.160.0), which also break with no space drawn after a hyphen
// or a slash, between ideographs and at other UAX #14 break opportunities. UAX #14 has none between two ASCII
// letters or digits (LB23, LB25, LB28), nor between a printable ASCII character and a following hyphen, slash,
// closing bracket or `.,:;!?` (LB13, LB15d, LB21).
const ASCII_LETTER_OR_DIGIT = /^[A-Za-z0-9]$/;
const ASCII_VISIBLE = /^[!-~]$/;
const ASCII_NO_BREAK_BEFORE = /^[-/.,:;!?)\]}]$/;
// A word of ASCII letters, digits, `'` and `.,:;`, which has no UAX #14 break opportunity inside it (LB13, LB19, LB23,
// LB25, LB28, LB29): Codex's re-pass keeps such a word whole when it starts on a row that already holds text.
const ASCII_UNBROKEN_WORD = /^[A-Za-z0-9'.,:;]+$/;

/** Whether the break between two drawn rows of a box must be whitespace of the box's text, given a lower bound of
 *  the box's width. Rows are measured as drawn, the box's own indentation included (an upper bound of their width);
 *  words are split at ASCII spaces only, which neither TUI breaks inside a word. `ownIndent` is how many cells of
 *  `row` the box draws itself (1 after the prompt glyph, 2 on a continuation row). Either:
 *  - the next row's first word would have fit on this row after a space: both wrappers fill a row first
 *    (wrap-ansi and FirstFit are greedy), so where the rows follow the wrapper's own lines the box breaks its rows
 *    there only at a line break of its text. Residual (review-safety-3 F1, from a model of the rust-v0.160.0 source,
 *    not a live capture): on Codex, once a row holding only indentation has absorbed and split a word (below), the
 *    re-pass can push a later row early at a hyphen, since its keep-whole check measures a hyphenated compound as one
 *    word, so a short row can be followed by a fragment that would have fit with no whitespace between them, and this
 *    rule counts that break as a space. Every such box in that model also holds the earlier absorbed split, which
 *    only this rule reads and which it rejects (the row is full), so the box reads `ambiguous`, never `exact`. That
 *    relies on the row-start check below, which the tests pin; or
 *  - no wrapper breaks between the two characters (ASCII_NO_BREAK_BEFORE above), the two words they end and begin,
 *    joined, fit in a row, the row's last word has no break opportunity inside it (ASCII_UNBROKEN_WORD), and the
 *    row's text starts at its first cell with a printable ASCII character. Codex 0.160.0 keeps a word that fits in a
 *    row whole only where the word starts on a row that already holds text, after whitespace or at one of textwrap's
 *    breaks: a row holding only indentation absorbs the next word and splits it where the row fills ("Partial
 *    whitespace rows absorb the next word"), and a word after a hyphen or a slash in a row that took the next
 *    textwrap line is split the same way. So on Codex a split between two letters is no space at all on a row that
 *    starts with indentation, or after a break opportunity inside the row's last word; only the first rule above
 *    reads such a break. */
function rowBreakIsSpace(row: string, next: string, width: number, ownIndent: number): boolean {
  const firstWord = next.trim().split(" ")[0]!;
  if (widthAtMost(row.trimEnd()) + 1 + widthAtMost(firstWord) <= width) return true;
  if (row.slice(0, ownIndent).trim() || !ASCII_VISIBLE.test(row.slice(ownIndent, ownIndent + 1))) return false;
  const lastWord = row.trim().split(" ").at(-1)!;
  if (!ASCII_UNBROKEN_WORD.test(lastWord)) return false;
  const before = lastWord.at(-1)!;
  const after = next.trimStart()[0] ?? "";
  const noBreak = (ASCII_LETTER_OR_DIGIT.test(before) && ASCII_LETTER_OR_DIGIT.test(after))
    || (ASCII_VISIBLE.test(before) && ASCII_NO_BREAK_BEFORE.test(after));
  return noBreak && widthAtMost(lastWord + firstWord) <= width;
}

/** Whether a Claude Code or Codex box, given as its rows, holds exactly `text` with its word boundaries kept.
 *  Whitespace inside a row is compared as one space (runs and Unicode spaces count the same, so `now here` is not
 *  `nowhere`), and letters are compared as they are (case included). A row break counts as the text's space only
 *  where it must be whitespace of the box's text (rowBreakIsSpace), measured against the box's widest row in
 *  printable ASCII cells (widthAtLeast), a lower bound of the box's width whatever else the rows hold. Any other
 *  break may fall inside a word of the box's text, or be how the box draws different spacing, so the reading is
 *  `ambiguous`, never `exact`, and so is a break that falls inside a word of the sent text. */
function boxHoldsText(rows: string[], text: string): "exact" | "ambiguous" | "other" {
  // The box draws its first row one cell after the prompt glyph, and its continuation rows two cells in.
  const drawn = rows.flatMap((row, index) => (row.trim() ? [{ row, ownIndent: index === 0 ? 1 : 2 }] : []));
  const shown = drawn.map(({ row }) => row.trim().replace(/\s+/g, " "));
  const sent = text.trim().replace(/\s+/g, " ");
  // Measured on the rows as drawn: whitespace compares as a space, but U+FEFF, which `\s` matches, takes no cell.
  const width = Math.max(0, ...drawn.map(({ row }) => widthAtLeast(row.trim())));
  let at = 0;
  let ambiguous = false;
  for (let i = 0; i < shown.length; i++) {
    const row = shown[i]!;
    if (!sent.startsWith(row, at)) return "other";
    at += row.length;
    if (i === shown.length - 1) break;
    if (sent[at] === " ") {
      at += 1;
      if (!rowBreakIsSpace(drawn[i]!.row, drawn[i + 1]!.row, width, drawn[i]!.ownIndent)) ambiguous = true;
    } else {
      ambiguous = true;
    }
  }
  if (at !== sent.length) return "other";
  return ambiguous ? "ambiguous" : "exact";
}

/** The row of Codex's running-turn status (`• Working (… esc to interrupt)`) above its input box, or -1. */
function codexTurnStatusAt(box: { lines: string[]; inputAt: number }): number {
  for (let i = box.inputAt - 1; i >= 0; i--) if (CODEX_TURN_STATUS_PATTERN.test(box.lines[i]!)) return i;
  return -1;
}

/** Codex 0.160.0's parent bottom-pane renderer replaces the normal composer for a modal; inline choices and
 *  previews follow the running status. Only scope generic selector history at this adjacent normal-frame slot.
 *  A draft, queued input, different visible version, missing footer or intervening content keeps the full scan.
 *  Source: openai/codex a956835d, tui/src/bottom_pane/mod.rs:2164-2310. Permission detectors keep their own scan. */
function codexCurrentSelectionLines(pane: string): string[] | null {
  if (readInputBox(pane, "codex", "") !== "empty") return null;
  const box = codexInputBox(pane)!;
  let status = box.inputAt - 1;
  while (status >= 0 && !box.lines[status]!.trim()) status--;
  if (status < 0 || !CODEX_TURN_STATUS_PATTERN.test(box.lines[status]!)) return null;
  return trimPaneLines(box.lines.slice(status).join("\n"));
}

/** Whether a Claude Code frame shows a running turn: `esc to interrupt` in the footer under its input box, or a
 *  live status row above the box (timer-less rows included): in the two rows above the box's opening rule, where
 *  Claude Code 2.1.296 draws its status row over a one-row margin whatever the box's height, or as
 *  `findClaudeComposer` reads it above a one-row box. Claude Code queues a message submitted during a turn, and it
 *  labels the queue only while a per-user hint counter is low, so an unlabelled queued message leaves the same
 *  empty box as a submit. With a statusLine configured (OpenRig installs one on every seat) and while the box holds
 *  text, the footer never draws `esc to interrupt`, so the status row is the running signal, but only while it is
 *  drawn: Claude Code hides it while streamed text is shown (SEAT_IDLE_SHAPES.claude.statusSlot). So this reading
 *  can only say a turn ran; a turn it misses is ruled out, if at all, by the seat reading before the paste. */
function claudeTurnRunning(pane: string): boolean {
  const { markerLine, closingRuleLine } = composerRegion(pane, "claude-code");
  if (closingRuleLine === null || markerLine === null) return false;
  const lines = pane.split("\n");
  if (lines.slice(closingRuleLine).some((row) => /esc to interrupt/.test(row))) return true;
  // markerLine is 1-based: the box's first row is lines[markerLine - 1] and its opening rule the row above it.
  const statusSlot = lines.slice(Math.max(0, markerLine - 4), Math.max(0, markerLine - 2)).map((row) => row.trim());
  if (statusSlot.some((row) => CLAUDE_LIVE_STATUS_PATTERN.test(row) || CLAUDE_TIMERLESS_STATUS_PATTERN.test(row))) return true;
  return findClaudeComposer(pane, { timerlessStatusIsLive: true })?.liveStatus != null;
}

// Claude's faint `Try "…"` suggestion in an empty box. The capture is unstyled, so it is read as other text and
// never as the sent text, even when the text is the suggestion itself.
const CLAUDE_TRY_SUGGESTION = /^Try"[^"]*"$/;

// Codex 0.160 lists messages waiting for a running turn above its input box under one of these headers, with
// `↳ <text>` rows (tui/src/bottom_pane/pending_input_preview.rs). Like Claude's queued label, such a row is generic:
// it says a message waits, not which one.
const CODEX_PENDING_INPUT_HEADER = /^• (?:Messages to be submitted (?:after next tool call|at end of turn)|Queued follow-up inputs)\b/;
const CODEX_PENDING_INPUT_ROW = new RegExp(`${CODEX_PENDING_INPUT_HEADER.source}|^↳ `);
const BRAILLE_SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

/** What the seat showed in the capture taken before the paste, with transport.verify_input_box on: `idle` only
 *  when the frame has one of the idle shapes below; `not-idle` when any row of it is a running, streaming,
 *  queued, pending-input or paste-hint row; `unknown` for anything else, including no capture and a frame that
 *  names another client version. Only `idle` lets a send read verified, so a seat whose running turn hides its
 *  signals reads unconfirmed. */
export type SeatReading = "idle" | "not-idle" | "unknown";

// Rows that rule out an idle seat wherever they are in the capture (compared trimmed). A transcript row that
// happens to match also reads not-idle, which only leaves the send unconfirmed.
const SEAT_NOT_IDLE_ROWS: Record<"claude-code" | "codex", RegExp[]> = {
  "claude-code": [CLAUDE_LIVE_STATUS_PATTERN, CLAUDE_TIMERLESS_STATUS_PATTERN, /esc to interrupt/, /paste again to expand/,
    /Press up to edit queued messages/, BRAILLE_SPINNER],
  codex: [CODEX_TURN_STATUS_PATTERN, /esc to interrupt/, CODEX_PENDING_INPUT_ROW, BRAILLE_SPINNER],
};

type RowShape = (lines: string[], at: number) => boolean;

// Codex 0.160's completion row (tui/src/history_cell/separators.rs, FinalMessageSeparator::label at rust-v0.160.0):
// `Worked for <elapsed>`, then ` • ` and the completion time (an optional date for another day, then the host's
// 12- or 24-hour clock, tui/src/clock_format.rs), then optional runtime metrics, each after ` • `, in source order.
// A live completion always has both the elapsed time and the time (chatwidget/completion.rs), so both are required.
// `<1s`, `{s}s`, `{m}m {s}s` or `{h}h {m}m {s}s`, with minutes and seconds below 60 and no leading zeros.
const CODEX_SIXTY = "(?:[0-9]|[1-5][0-9])";
const CODEX_NONZERO_SIXTY = "(?:[1-9]|[1-5][0-9])";
const CODEX_ELAPSED = `(?:<1s|${CODEX_NONZERO_SIXTY}s|${CODEX_NONZERO_SIXTY}m ${CODEX_SIXTY}s|[1-9][0-9]*h ${CODEX_SIXTY}m ${CODEX_SIXTY}s)`;
// `%b %-d at ` (this year) or `%b %-d, %Y at ` (another year); nothing for today.
const CODEX_DATE = "(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12][0-9]|3[01])(?:, [0-9]{4})? at )?";
// `%-I:%M %p` (TwelveHour) or `%H:%M` (TwentyFourHour).
const CODEX_CLOCK = "(?:(?:[1-9]|1[0-2]):[0-5][0-9] [AP]M|(?:[01][0-9]|2[0-3]):[0-5][0-9])";
// runtime_metrics_label: format_duration_ms gives `<n>.<d>s` from one second, `<n>ms` below it.
const CODEX_MS = "(?:[0-9]+\\.[0-9]s|[0-9]+ms)";
const CODEX_TTFT_TBT = `(?:${CODEX_MS} \\(iapi\\)(?: ${CODEX_MS} \\(service\\))?|${CODEX_MS} \\(service\\))`;
// A metric is shown only for a count above zero; pluralize() gives the singular for exactly one.
const CODEX_MANY = "(?:[2-9]|[1-9][0-9]+)";
const CODEX_COUNT = "[1-9][0-9]*";
const CODEX_METRICS = [
  `Local tools: (?:1 call|${CODEX_MANY} calls) \\(${CODEX_MS}\\)`,
  `Inference: (?:1 call|${CODEX_MANY} calls) \\(${CODEX_MS}\\)`,
  `WebSocket: ${CODEX_COUNT} events send \\(${CODEX_MS}\\)`,
  `(?:Stream: 1 event|Streams: ${CODEX_MANY} events) \\(${CODEX_MS}\\)`,
  `${CODEX_COUNT} events received \\(${CODEX_MS}\\)`,
  `Responses API overhead: ${CODEX_MS}`,
  `Responses API inference: ${CODEX_MS}`,
  `TTFT: ${CODEX_TTFT_TBT}`,
  `TBT: ${CODEX_TTFT_TBT}`,
].map((metric) => `(?: • ${metric})?`).join("");
const CODEX_COMPLETION_ROW = new RegExp(`^ {2}Worked for ${CODEX_ELAPSED} • ${CODEX_DATE}${CODEX_CLOCK}${CODEX_METRICS}$`);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Claude Code 2.1.296's completion row, which ends a finished turn in the transcript (the bundle's turn-duration
// row): the `✻` glyph in a two-cell column at column 0, then `<verb> for <duration> · done <time>`. The verb is one
// of the bundle's past-tense list, picked from the turn's id. The duration is the bundle's duration format:
// `<s>s` below a minute (`0.0s` below 1 ms), `<m>m <s>s`, `<h>h <m>m <s>s`, `<d>d <h>h <m>m`, without leading
// zeros. The time is the clock of a turn that finished today in the en-US forms of the bundle's time-format
// presets: `auto` (en-US) and `12-hour` (`5:24 PM`), `24-hour` (`17:24`, `09:05`), `24-hour-utc` (`17:24Z`); real
// frames of OpenRig-launched seats show the 12-hour form. Anything after the time
// (a still-running note, hidden-message or budget notes), a row without `· done`, another locale, a custom
// pattern or the weekday and date of an earlier day is not on this list.
const CLAUDE_COMPLETION_VERBS = ["Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Saut\u00e9ed", "Worked"];
const CLAUDE_SIXTY = "(?:[0-9]|[1-5][0-9])";
const CLAUDE_NONZERO_SIXTY = "(?:[1-9]|[1-5][0-9])";
const CLAUDE_HOURS = "(?:[0-9]|1[0-9]|2[0-3])";
const CLAUDE_NONZERO_HOURS = "(?:[1-9]|1[0-9]|2[0-3])";
const CLAUDE_DURATION = `(?:0\\.0s|${CLAUDE_SIXTY}s|${CLAUDE_NONZERO_SIXTY}m ${CLAUDE_SIXTY}s`
  + `|${CLAUDE_NONZERO_HOURS}h ${CLAUDE_SIXTY}m ${CLAUDE_SIXTY}s|[1-9][0-9]*d ${CLAUDE_HOURS}h ${CLAUDE_SIXTY}m)`;
const CLAUDE_CLOCK = "(?:(?:[1-9]|1[0-2]):[0-5][0-9] [AP]M|(?:[01][0-9]|2[0-3]):[0-5][0-9]Z?)";
const CLAUDE_COMPLETION_ROW = new RegExp(`^✻ (?:${CLAUDE_COMPLETION_VERBS.join("|")}) for ${CLAUDE_DURATION} · done ${CLAUDE_CLOCK}$`);

/** The idle allow-list. Each entry comes from real Claude Code 2.1.296 and Codex 0.160.0 frames
 *  (test/fixtures/input-box, including idle seats OpenRig launched: openrig-seat-*), or, where no frame was captured,
 *  from the Claude Code 2.1.296 bundle, the Codex 0.160.0 source or OpenRig's own launch code, as each entry says; a
 *  frame that matches none of them is not proven idle. */
const SEAT_IDLE_SHAPES: {
  claude: {
    openingRules: { plain: RegExp; named: (sessionName: string) => RegExp };
    footers: Record<"bypassPermissions" | "acceptEdits" | "auto" | "dontAsk" | "plan" | "default", string>;
    statusLineRows: string[];
    boxes: RegExp[];
    notices: string[];
    statusSlot: Record<"finishedTurn" | "freshSession", RowShape>;
  };
  codex: { hints: RegExp[]; above: Record<"finishedTurn" | "freshSession", RowShape> };
} = {
  claude: {
    // The box's opening rule. Plain (the captured frames: a seat started without a name), or carrying this seat's
    // own session name: OpenRig launches every Claude seat with `--name <session>` (claude-code-adapter.ts), which
    // Claude Code draws on the box's top border as `─…─ <name> ─`, as wide as the closing rule (2.1.296 bundle:
    // the prompt-border banner draws the rule, the name padded by one space each side, then one `─`). Real frames
    // of OpenRig seats from earlier Claude Code versions end it with `──` (session-transport.test.ts,
    // fixtures/walk-staged-specimen), so one or two are accepted; real 2.1.296 OpenRig seats (openrig-seat-*) draw
    // one. Any other name, or a truncated one, is unknown.
    openingRules: {
      plain: /^─{10,}$/,
      named: (sessionName: string) => new RegExp(`^─+ ${escapeRegExp(sessionName)} ─{1,2}$`),
    },
    // The footer under an empty box when no turn runs, one per permission posture claudePostureFlag can launch
    // (yolo-mode.ts: --dangerously-skip-permissions, or --permission-mode with any mode Claude Code 2.1.296 offers).
    // Bypass and accept edits are real (openrig-seat-*; bypass also after-enter-15s.J, idle-fresh-suggestion). The
    // others are drawn by the 2.1.296 bundle's footer (the mode's symbol and indicator plus ` on`,
    // ` (shift+tab to cycle)` for every mode but default, then ` · ← for agents` while the box is empty); accept edits
    // also matches a real 2.1.220 capture (claude-warning-footer-readiness.test.ts). OpenRig's statusLine makes the footer drop its hints
    // (`? for shortcuts`, `esc to interrupt`), so these rows are the same whether or not a turn runs: the status
    // slot above the box (`statusSlot` below) is what tells a running turn apart.
    footers: {
      bypassPermissions: "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
      acceptEdits: "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
      auto: "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
      dontAsk: "⏵⏵ don't ask on (shift+tab to cycle) · ← for agents",
      plan: "⏸ plan mode on (shift+tab to cycle) · ← for agents",
      default: "⏸ manual mode on · ← for agents",
    },
    // The rows OpenRig's statusLine collector (provisionContextCollector, assets/claude-statusline-context.cjs) draws
    // between the closing rule and the footer: none. It prints nothing to stdout, and Claude Code 2.1.296 draws no
    // row for an empty statusLine in the classic renderer OpenRig launches with (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1).
    // A statusLine that prints anything (a person's own command) is not on this list.
    statusLineRows: [],
    // The one row between the box's two rules: empty (after-enter-15s.J), or the Try suggestion (idle-fresh-suggestion).
    boxes: [/^❯$/, /^❯\s+Try "[^"]*"$/],
    // The row just above the opening rule: blank (after-enter-15s.J), the effort row (idle-fresh-suggestion), or a
    // tmux notice (cleared-without-enter.J, staged-short).
    notices: ["", "◐ medium · /effort",
      "tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' to ~/.tmux.conf for wheel scroll",
      "tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus tracking"],
    // The status slot, the row above that, read together with the rows above it when it is blank: the first
    // non-blank row at or above the slot must be one of these. With OpenRig's statusLine the footer shows no running
    // signal, so this slot is what tells a running turn apart, and the 2.1.296 bundle says what a running turn leaves
    // there. Its REPL draws the live status row (the spinner) only while
    // `isLoading && (!hasDisplayedStreamingText || tailBlank || …)`: once streamed text with a complete line is on
    // screen it hides the spinner, and draws nothing in its place (the slot component renders only a retry banner,
    // or null), so the last streamed row moves down into the slot. That row is never the completion row: Claude Code
    // draws a message behind a two-cell `●` column (continuation rows two spaces in), the user's echo after `❯ `,
    // tool output indented. But the bundle does not show that the last streamed row is never blank (the streamed
    // markdown is laid out in a column with a one-row gap, and its unfinished last line is hidden), so a blank slot
    // under transcript text is not proof of an idle seat and reads unknown. A blank slot counts only where nothing
    // of a newer turn can be under the row it sits below:
    // - finishedTurn: the completion row at column 0 (CLAUDE_COMPLETION_ROW). In the classic renderer OpenRig
    //   launches Claude with, the box follows the transcript, so an idle seat that has finished a turn shows that
    //   turn's completion row in the slot itself (openrig-seat-*: real OpenRig-launched seats); in the fullscreen
    //   renderer the box is pinned to the bottom and blank rows sit between them (after-enter-15s.J). A newer turn
    //   draws its echo, its status row or its `●` rows under the completion row.
    // - freshSession: the last row of the welcome banner of Claude Code v2.1.296, before any turn (idle-fresh-
    //   suggestion, cleared-without-enter.J).
    // Any other row reads unknown.
    statusSlot: {
      finishedTurn: (lines: string[], at: number) => CLAUDE_COMPLETION_ROW.test(lines[at] ?? ""),
      freshSession: (lines: string[], at: number) => at >= 2 && /^ ▝▝ {3}▝▝ {3}[~/]/.test(lines[at]!)
        && /^▝▜██████▀ {2}\S/.test(lines[at - 1]!) && /^ ▐▛███▛█ {3}Claude Code v2\.1\.296$/.test(lines[at - 2]!),
    },
  },
  codex: {
    // The hint row under the status line of an empty box (product-path-idle.J, idle).
    hints: [/^\? for shortcuts$/, /^\? for shortcuts\s+⚠ \d+ warnings? · f2 to view$/],
    // The last non-blank row above the empty box: the completion row Codex adds when a turn completes
    // (after-enter-15s.J; its grammar is CODEX_COMPLETION_ROW above), or the greeting under the session header
    // before any turn (idle, product-path-idle.J, cleared-without-enter.J). A running or streaming turn draws rows
    // below either.
    above: {
      finishedTurn: (lines: string[], at: number) => CODEX_COMPLETION_ROW.test(lines[at] ?? ""),
      freshSession: (lines: string[], at: number) => {
        if (!/^ {2}\S/.test(lines[at] ?? "")) return false;
        let i = at - 1;
        while (i >= 0 && !lines[i]!.trim()) i--;
        return i >= 2 && i < at - 1 && /^ {2}permissions: \S/.test(lines[i]!) && /^ {5}[~/]/.test(lines[i - 1]!)
          && /^ {2}>_ OpenAI Codex \(v0\.160\.0\)$/.test(lines[i - 2]!);
      },
    },
  },
};

function claudeSeatIdle(lines: string[], sessionName?: string): boolean {
  const idle = SEAT_IDLE_SHAPES.claude;
  let footer = lines.length - 1;
  while (footer >= 0 && !lines[footer]!.trim()) footer--;
  const closing = footer - 1 - idle.statusLineRows.length;
  if (closing < 4) return false;
  const width = (row: string) => [...row].length;
  const plainRule = (row: string) => idle.openingRules.plain.test(row);
  const openingRule = (row: string) => plainRule(row)
    || (!!sessionName && idle.openingRules.named(sessionName).test(row) && width(row) === width(lines[closing]!));
  return Object.values(idle.footers).includes(lines[footer]!.trim())
    && idle.statusLineRows.every((row, i) => lines[closing + 1 + i]!.trim() === row) && plainRule(lines[closing]!)
    && idle.boxes.some((box) => box.test(lines[closing - 1]!)) && openingRule(lines[closing - 2]!)
    && idle.notices.includes(lines[closing - 3]!.trim()) && claudeStatusSlotIdle(lines, closing - 4);
}

/** The status slot (see SEAT_IDLE_SHAPES.claude.statusSlot): its own row, or, when it is blank, the first non-blank
 *  row above it. */
function claudeStatusSlotIdle(lines: string[], slot: number): boolean {
  let at = slot;
  while (at >= 0 && !lines[at]!.trim()) at--;
  return at >= 0 && Object.values(SEAT_IDLE_SHAPES.claude.statusSlot).some((shape) => shape(lines, at));
}

function codexSeatIdle(pane: string): boolean {
  const box = codexInputBox(pane);
  if (box === null || box.text) return false;
  const lines = box.lines.map((row) => row.trimEnd());
  let hint = lines.length - 1;
  while (hint >= 0 && !lines[hint]!.trim()) hint--;
  if (!SEAT_IDLE_SHAPES.codex.hints.some((row) => row.test(lines[hint]!.trim()))) return false;
  let above = box.inputAt - 1;
  while (above >= 0 && !lines[above]!.trim()) above--;
  return Object.values(SEAT_IDLE_SHAPES.codex.above).some((shape) => shape(lines, above));
}

// The client versions the idle layouts and box readers were recorded from, and the rows in which each client names
// the version it runs: Claude Code's welcome banner (`Claude Code v2.1.296`), Codex's session header
// (`>_ OpenAI Codex (v0.160.0)`) and its update notice, whose first version is the running one
// (`Update available! 0.160.0 -> 0.162.1`). These are only what the frames show; nothing here discovers a version. A frame where one of them names another version is not read as these
// layouts. Most frames name no version (the banner and header scroll away), and then a matching layout is evidence
// about the layout only, not proof of the client version: another version that draws the same rows reads the same.
const RECORDED_CLIENT_VERSION: Record<"claude-code" | "codex", string> = { "claude-code": "2.1.296", codex: "0.160.0" };
const VISIBLE_CLIENT_VERSION: Record<"claude-code" | "codex", RegExp[]> = {
  "claude-code": [/Claude Code v(\d[\w.+-]*)/g],
  codex: [/OpenAI Codex \(v(\d[\w.+-]*)\)/g, /Update available! (\d[\w.+-]*) -> /g],
};

/** Whether a frame visibly names a client version other than the recorded one (see RECORDED_CLIENT_VERSION). */
function namesAnotherClientVersion(pane: string, runtime: "claude-code" | "codex"): boolean {
  return VISIBLE_CLIENT_VERSION[runtime].some((pattern) =>
    [...pane.matchAll(pattern)].some((match) => match[1] !== RECORDED_CLIENT_VERSION[runtime]));
}

/** The seat before the paste (see SeatReading), read from the capture the transport already takes before it.
 *  `sessionName` is the seat's own session name, which a Claude Code seat launched by OpenRig draws on its box.
 *  A frame that names another client version is `unknown`. */
export function readSeatBeforePaste(pane: string | null, runtime: "claude-code" | "codex", sessionName?: string): SeatReading {
  if (!pane?.trim()) return "unknown";
  const lines = pane.split("\n").map((row) => row.trimEnd());
  if (lines.some((row) => SEAT_NOT_IDLE_ROWS[runtime].some((pattern) => pattern.test(row.trim())))) return "not-idle";
  if (namesAnotherClientVersion(pane, runtime)) return "unknown";
  return (runtime === "codex" ? codexSeatIdle(pane) : claudeSeatIdle(lines, sessionName)) ? "idle" : "unknown";
}

/** What a Claude Code or Codex input box shows, read from the input box only (never the transcript). Labels and
 *  placeholders (Claude's queued label and Try suggestion, collapsed pastes, Codex's empty-box placeholder) are
 *  checked before the sent text, so none of them can read as `exact`. The sent text is `exact` only with its word
 *  boundaries kept, and `ambiguous` where the box's row breaks leave them uncertain (boxHoldsText). A frame that
 *  names another client version reads `unrecognized` (RECORDED_CLIENT_VERSION).
 *
 *  An empty box also reads `queued` where the frames say the message may wait behind a turn: Codex's
 *  pending-input rows above the box, rows between Codex's running-turn status row and the box, or
 *  `beforeEnter` (the frame read just before Enter) showing a running turn (Codex's status row, or
 *  `claudeTurnRunning`). These readings decide the verdict: verified needs `empty` after Enter. For a seat that
 *  was not idle before the paste they only say why the send is unconfirmed (readSeatBeforePaste already rules it
 *  out), but for a seat that was idle they are the only check that rejects a message queued behind a turn that
 *  started after the pre-paste capture and shows in the frame read before Enter.
 *  Used only to report a send with transport.verify_input_box on. */
export function readInputBox(pane: string | null, runtime: "claude-code" | "codex", text: string, beforeEnter?: string | null): InputBoxReading {
  if (!pane?.trim()) return "unavailable";
  if (namesAnotherClientVersion(pane, runtime)) return "unrecognized";
  if (runtime === "codex") {
    const box = codexInputBox(pane);
    if (box === null) return "unrecognized";
    if (!box.text) {
      const before = beforeEnter ? codexInputBox(beforeEnter) : null;
      const status = codexTurnStatusAt(box);
      const rowsBehindTurn = status >= 0 && box.lines.slice(status + 1, box.inputAt).some((row) => row.trim());
      const pendingInput = box.lines.slice(0, box.inputAt).some((row) => CODEX_PENDING_INPUT_ROW.test(row.trim()));
      return pendingInput || rowsBehindTurn || (before !== null && codexTurnStatusAt(before) >= 0) ? "queued" : "empty";
    }
    if (CODEX_COLLAPSED_PASTE.test(box.text)) return "hidden";
    return boxHoldsText(box.rows, text);
  }
  const { body, markerLine, closingRuleLine } = composerRegion(pane, runtime);
  if (body === null) return "unrecognized";
  if (!body) return beforeEnter && claudeTurnRunning(beforeEnter) ? "queued" : "empty";
  if (body === QUEUED_PLACEHOLDER) return "queued";
  if (COLLAPSED_PASTE.test(body)) return "hidden";
  if (CLAUDE_TRY_SUGGESTION.test(body)) return "other";
  // composerRegion's body has every space removed (the startup guard's matcher, unchanged); identity reads the rows.
  return boxHoldsText(stripBoxGlyph(pane.split("\n").slice(markerLine! - 1, closingRuleLine! - 1)), text);
}

export interface SendOpts {
  /** Internal provenance derived by the transport route. */
  identityProvenance?: string;
  /** Internal wake provenance, never accepted from the public transport route. */
  queueWake?: boolean;
  /** Internal: this send is OpenRig's own (a watchdog, a scheduler wake, a notice, the compaction enforcer). Never accepted
   *  from HTTP send options. It marks the send's source for the seat's interruption level and changes nothing else. */
  openrigNotice?: true;
  /** Marked urgent, and by whom (the authenticated sender, or the queue item's source). A seat's interruption level lets an
   *  urgent message type; it's shown on delivery. */
  urgent?: { by: string };
  /** Internal, for a combined queue wake: called under the seat's lease, where delivery is decided (`held` is that
   *  decision), with how the seat's level would treat each input now. It returns the members that still go with this send:
   *  their text and outbox ids. Never accepted from HTTP. */
  recheckMembers?: (holds: (input: AdmissionInput) => boolean, held: boolean) => { text: string; outboxIds: string[] };
  /** Internal observation of a completed input effect; never a permission callback. */
  onInputEffect?: (phase: "pasted" | "submitted") => void;
  /** Internal managed lifecycle prerequisite; never accepted from HTTP send options. */
  beforeWrite?: () => void;
  /** The caller's request. Aborted while the send still waits, before any input starts, the send ends with
   *  `caller_cancelled` and never writes, then or later. Once input may have started it is ignored: the result stays
   *  attempted or written. Queue wakes and committed outbox deliveries have no caller and ignore it. */
  signal?: AbortSignal;
  /** Optional reference for a manually held record; never deduplicates an explicit input request. */
  deliveryId?: string;
  auditPointer?: string;
  /** Internal queue seam: already committed original members, never client-supplied. */
  committedOutboxIds?: string[];
  verify?: boolean;
  force?: boolean;
  waitForIdleMs?: number;
  /** Internal #1084 seam: a lease-free idle wait already completed in send()
   *  before the serial lease; sendUnguarded consumes this evidence instead of
   *  waiting again, then re-checks readiness just before typing. Never
   *  client-supplied. */
  preWaitedIdle?: { activity: AgentActivity; waitedMs: number; attempts: number; deadlineAt: number };
  /** Internal #1084 seam: the delivery-guard target bound before the
   *  lease-free wait; the leased send refuses with guard_target_changed when
   *  the seat changed hands meanwhile. Never client-supplied. */
  preWaitBound?: GuardTarget;
  /** Internal, with `waitForIdleMs`: decide idle from a live pane read only. A runtime hook can't
   *  authorize the send (a hook saying the seat waits on a person still refuses). For a caller whose
   *  latest hook may predate the state that matters, such as a post-compact drain whose newest hook
   *  can be the Stop from before /compact. */
  readinessFromPaneOnly?: boolean;
  /** Internal, for the managed compaction's post-compaction turn boundary only. The rows above the input box are then
   *  indented compaction output, so the pane classifier can't see the status head; a complete, framed, empty Claude box
   *  with its mode footer and no live status reads idle for this send. Every other send keeps unknown as never idle. */
  postCompactTurnBoundary?: boolean;
  // OPR.0.4.1.10 — interactive-prompt / permission guard.
  // `dangerouslyInteract` is the ONLY override of the prompt/permission guard (force does NOT bypass
  // it). It requires `reason` and writes an auditable `transport.prompt_override` record before the
  // send. `actorSession` is the caller identity recorded in that audit. (`--raw` is purely a CLI-side
  // envelope concern — the daemon guard behaves identically for raw and wrapped text.)
  dangerouslyInteract?: boolean;
  /** Explicit per-send choice: no input inspection or clearing. Only with dangerouslyInteract. */
  typeWithoutChecking?: boolean;
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
  /** The text without the From/To envelope. When set and the recipient is a terminal seat
   *  (`runtime: terminal`), send() types this instead of `text`, so the shell never runs the
   *  envelope lines. Agent recipients keep `text`. */
  exactText?: string;
  /** Internal: send() is typing `exactText` to a terminal seat, so its bytes stay exactly as given: no urgent line, which
   *  the shell would run. An urgent mark still admits the input and stays in the result. Never accepted from HTTP. */
  typedExactly?: true;
}

const CALLER_CANCELLED = "caller_cancelled";

/** The readiness reason's tail when only the retained hook says the seat waits on a person: the pane shows no prompt it
 *  recognizes. */
const LATEST_HOOK_ONLY = "latest hook, pane unrecognized";

/** What to do when the refusal rests only on a retained hook (a Claude waiting hook, or a Codex permission request the pane
 *  can't confirm): a prompt declined or answered with no hook after it reads that way until someone who saw it end says so. */
function clearAttentionHint(sessionName: string, reason: string): string {
  return reason.endsWith(LATEST_HOOK_ONLY) || reason === "permission_request_unverified"
    ? ` Look first: rig capture ${sessionName}. If that prompt is gone (declined or answered), clear it: rig seat clear-attention ${sessionName} --reason "<what you saw>".`
    : "";
}

/** The caller's cancellation signal, or none for sends no caller owns (queue wakes, committed outbox deliveries). */
function callerSignal(opts?: SendOpts): AbortSignal | undefined {
  return opts?.queueWake || opts?.committedOutboxIds ? undefined : opts?.signal;
}

function callerCancelled(sessionName: string): SendResult {
  return { ok: false, sessionName, sent: false, inputPhase: "not_reached", reason: CALLER_CANCELLED,
    error: `The request was cancelled before any input started. Nothing was typed into '${sessionName}', and nothing will be.` };
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

/** Transient caller-only evidence. Never put these rows in receipts, events or held messages. */
export interface ExistingInput {
  target: GuardTarget;
  classification: "typed_or_pasted" | "suggestion_only" | "empty" | "unreadable" | "not_checked";
  rows: string[];
  suggestionRows: string[];
  cursor: ComposerSnapshot["cursor"] | null;
  fullContentsVisible: boolean;
  reason?: string;
  cleared: false;
}

type OverrideInputAudit = { classification: ExistingInput["classification"]; visibleRows: number; suggestionRows: number; choice: "inspect" | "type_without_checking"; outcome: "stopped" | "proceed"; clearAttempted: false };

export interface SendResult {
  existingInput?: ExistingInput;
  ok: boolean;
  sessionName: string;
  /** Present when the send was marked urgent: who marked it. */
  urgent?: { by: string };
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
  delivery?: GuardedDeliverySummary;
  warning?: string;
  error?: string;
  reason?: string;
  /** Set on the submit-only (bare Enter) mode's success — no text was typed. */
  submitOnly?: boolean;
  activity?: AgentActivity;
  waitedMs?: number;
  attempts?: number;
  sent?: boolean;
  /** The recipient is a terminal seat, so `exactText` was typed without the From/To envelope. */
  envelopeOmitted?: true;
  /** Context, not a status: the seat was in a managed compaction or restore OpenRig had recorded when this send ran. The
   *  send's own result (ok, outcome, error) is unchanged by it, and it never says the restore finished. */
  managedCompaction?: { stage: string; observed: "before_send" | "after_send"; notice: string };
  /** How far the send got toward the seat's input, where that is positively known:
   *  `not_reached` — an idle wait refused the send before any write was attempted;
   *  `attempted` — the text write was issued and reported a failure (it may still have landed);
   *  `written` — the text was written and the send stopped before or at Enter (it may sit in the input box). */
  inputPhase?: "not_reached" | "attempted" | "written";
}

/** One reading of a Claude Code or Codex input box: `exact` (the sent text, word boundaries kept), `ambiguous`
 *  (the sent text, but a row break in the box may fall inside a word, so its word boundaries cannot be told),
 *  `empty`, `queued` (Claude's queued-messages label, or an empty box while a turn was running, so the message may
 *  wait behind it), `hidden` (a collapsed paste label), `other` (any other text), `unrecognized` (no recognized
 *  input box, or a frame that names another client version) or `unavailable` (no capture, or none in time). */
export type InputBoxReading = "exact" | "ambiguous" | "empty" | "queued" | "hidden" | "other" | "unrecognized" | "unavailable";

/** With transport.verify_input_box on: what the seat showed before the paste, and what a Claude Code or Codex
 *  input box showed before and after Enter. It decides the send's verdict: `verified` is true only for a seat
 *  proven idle before the paste, then exact, then empty, on the same pane process (`#{pane_pid}`, the pane's root
 *  process); that means the box was cleared after holding the text, normally by our Enter, never that the model
 *  read it. `sameProcess` compares the pane's root process (usually a shell) and the seat's binding: an agent
 *  restarted under the same shell is not caught by it, and the same pane and binding are not proof of the same
 *  native conversation. An audited prompt answer reads no box, so it reads unconfirmed. */
interface InputBoxEvidence {
  seat: SeatReading;
  before: InputBoxReading;
  after: InputBoxReading;
  sameProcess: boolean;
}

export interface CaptureResult {
  ok: boolean;
  sessionName: string;
  content?: string;
  lines?: number;
  error?: string;
  reason?: string;
  /** Claude Code and Codex seats, when the caller asked: what the live input box holds, and which part is likely a
   *  harness suggestion. */
  inputBox?: InputBoxAnnotation;
  /** When the caller asked: the captured screen is at a prompt in a pane smaller than 80x24, which may cut it off. */
  promptPane?: { width: number; height: number; hint: string };
  /** When the caller asked to read at a readable size: the size it asked for and what letting the window go did, or
   *  why the window wasn't resized. */
  readable?: { resized: true; width: number; height: number; release: PinRelease; sizeBack?: string } | { resized: false; reason: string };
}

export interface BroadcastResult {
  total: number;
  sent: number;
  retained?: number;
  failed: number;
  results: SendResult[];
}

export interface TransportReadinessChecker {
  checkReady?(binding: NodeBinding, options?: ReadinessOptions): Promise<ReadinessResult>;
}

interface SessionTransportDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  tmuxAdapter: TmuxAdapter;
  agentActivityStore?: AgentActivityStore;
  // A positive-picker override requires a working audit sink. Other explicit interaction attempts
  // audit too, but an unavailable sink stays advisory so an already accepted send is not refused.
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
  runtimeAdapters?: Record<string, TransportReadinessChecker>;
  /** transport.verify_input_box, read per verified Claude Code or Codex send. Absent means off. */
  verifyInputBox?: () => boolean;
}

interface SessionRow { node_id: string; session_name: string; }
interface NodeRow { rig_id: string; logical_id: string; }
interface SessionMetaRow { community_harness: string | null; runtime: string | null; attachment_type: string | null; node_id: string | null; binding_session: string | null; pane: string | null; occupant: string | null; resume_token: string | null;
  resume_provenance: string | null; resume_rotated_from: string | null; resume_rotated_process: string | null; resume_launch_process: string | null; }
interface ResolvedTarget { sessionName: string; rigName: string; nodeLogicalId: string; }
interface AbsenceProbeTarget { session_id: string; node_id: string; session_name: string; tmux_pane: string | null; }
interface SessionReconciliationSnapshot {
  node_id: string;
  rig_id: string;
  session_id: string;
  session_name: string;
  runtime: string;
  cwd: string | null;
  startup_status: string;
  session_status: string;
  startup_completed_at: string | null;
  resume_type: string | null;
  resume_token: string | null;
  resume_provenance: string | null;
  resume_rotated_from: string | null;
  resume_rotated_process: string | null;
  resume_launch_process: string | null;
  binding_session: string | null;
  binding_window: string | null;
  binding_pane: string | null;
  binding_updated_at: string | null;
  occupant_generation: string | null;
  latest_session_id: string;
  startup_event_seq: number | null;
}

export class SessionTransport {
  readonly db: Database.Database;
  readonly guardedDelivery?: DraftAwareDelivery;
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
  private runtimeAdapters: Record<string, TransportReadinessChecker>;
  private inFlightReconciliations = new Map<string, Promise<boolean>>();
  private verifyInputBox?: () => boolean;

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
    this.runtimeAdapters = deps.runtimeAdapters ?? {};
    this.verifyInputBox = deps.verifyInputBox;
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && (this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>).some(c => c.name === "guard_delivery")) this.guardedDelivery = new DraftAwareDelivery(this.db, guard,
      (session, text, opts) => this.sendUnguarded(session, text, opts));
  }

  configureGuardedWakes(applicable: (entries: readonly QueueWakeFacts[]) => boolean): void {
    this.guardedDelivery?.configureWakes(applicable);
  }

  attachRuntimeAdapters(adapters: Record<string, TransportReadinessChecker>): void {
    this.runtimeAdapters = { ...this.runtimeAdapters, ...adapters };
  }

  /** Freeze the registration and binding before asking tmux about this name. */
  private absenceProbeTarget(sessionName: string): AbsenceProbeTarget | undefined {
    sessionName = physicalSessionName(this.db, sessionName);
    return this.db
      .prepare(`
        SELECT s.id AS session_id, n.id AS node_id, s.session_name AS session_name, b.tmux_pane AS tmux_pane
        FROM nodes n
        JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        JOIN bindings b ON b.node_id = n.id AND b.tmux_session = s.session_name
        WHERE s.status = 'running'
          AND s.session_name = ?
        LIMIT 1
      `)
      .get(sessionName) as AbsenceProbeTarget | undefined;
  }

  /** Positive tmux absence only; a delayed reply cannot describe a replacement. */
  private recordSessionMissingVerdict(target: AbsenceProbeTarget | undefined, observedAt: string): void {
    if (!target || target.tmux_pane === null) return;
    const current = this.absenceProbeTarget(target.session_name);
    if (!current || current.session_id !== target.session_id || current.node_id !== target.node_id
      || current.tmux_pane !== target.tmux_pane) return;
    new SeatIdentityStore(this.db).upsert({
      nodeId: target.node_id,
      verdict: "pane_missing",
      evidenceSource: "tmux_session",
      reason: "session_missing",
      evidence: { registeredPane: target.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: target.session_name,
      observedAt,
    });
  }

  private getSessionMeta(sessionName: string): {
    runtime: string | null; attachmentType: string | null; nodeId: string | null; pane: string | null; occupant: string | null; resumeToken: string | null;
    rotation: ClaudeResumeRotation | null;
    communityHarness: string | null;
  } {
    sessionName = physicalSessionName(this.db, sessionName);
    // One existing statement; P2 reads the binding columns it already joins plus the
    // same current-occupant subselect the delivery guard uses. No extra query.
    const row = this.db.prepare(`
      SELECT
        n.runtime AS runtime,
        ${sessionCommunityHarnessSelect(this.db)} AS community_harness,
        b.attachment_type AS attachment_type,
        n.id AS node_id,
        b.tmux_session AS binding_session,
        b.tmux_pane AS pane,
        s.resume_token AS resume_token,
        s.resume_provenance AS resume_provenance,
        s.resume_rotated_from AS resume_rotated_from,
        s.resume_rotated_process AS resume_rotated_process,
        s.resume_launch_process AS resume_launch_process,
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
      communityHarness: communityHarnessOf(row?.community_harness, row?.runtime),
      attachmentType: row?.attachment_type ?? null,
      nodeId: row?.node_id ?? null,
      // The row may be a historical session of a node now bound elsewhere: only a
      // binding whose session IS this name labels pane/occupant; otherwise unknown.
      pane: row?.binding_session === sessionName ? row?.pane ?? null : null,
      occupant: row?.binding_session === sessionName ? row?.occupant ?? null : null,
      resumeToken: row?.resume_token ?? null,
      rotation: claudeResumeRotation(row),
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
    const current = this.sessionRegistry.resolveAddress(sessionName);
    if (current) return { ok: true, sessions: [{ sessionName, rigName: current.rigName, nodeLogicalId: current.logicalId }] };
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
      const identity = this.sessionRegistry.resolveAddress(name)?.nodeId ?? name;
      if (seen.has(identity)) continue;
      seen.add(identity);
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

  /** With an input, whether the seat's level would hold that input; without one, whether its mode holds everything. */
  retentionTarget(sessionName: string, input?: AdmissionInput) {
    const guard = this.tmuxAdapter.deliveryGuard;
    const target = guard?.maybeTarget(sessionName);
    if (!guard || !target) return null;
    if (input) return guard.holdsInput(target.nodeId, input) ? target : null;
    const pref = guard.preference(target.nodeId);
    return pref.desired || pref.effective ? target : null;
  }

  draftAwareTarget(sessionName: string) {
    const guard = this.tmuxAdapter.deliveryGuard;
    const target = guard?.maybeTarget(sessionName);
    if (!guard || !target) return null;
    const policy = guard.configuration(target.nodeId);
    return policy.desired.mode === "draft-aware" || policy.effective.mode === "draft-aware" ? target : null;
  }

  /** Deliver text and Enter to the resolved recipient under the send guards.
   * With verification requested, compare rendered message counts, excluding
   * agent input; a confirmed render does not prove agent consumption. */
  /** The managed compaction state OpenRig has recorded for a seat (the compaction enforcer's), for the sender's notice. */
  private compactionObserver?: (sessionName: string) => { stage: string; detail: string } | null;
  setCompactionObserver(observer: (sessionName: string) => { stage: string; detail: string } | null): void {
    this.compactionObserver = observer;
  }

  /**
   * Deliver as always; when the seat was in a managed compaction or restore OpenRig had recorded, before or after the
   * send, add a notice saying so. The notice is context beside the send's own result, which it never changes.
   */
  async send(sessionName: string, text: string, opts?: SendOpts): Promise<SendResult> {
    // A terminal seat's shell would run the envelope lines as commands. Swap before the guard,
    // whose outbox body, hash and delivery-ID identity all key on the text actually typed.
    // Without the envelope there's no Sent: line, so stampISO is dropped too: the delivered-latency
    // segment must never edit a line of the exact text.
    if (opts?.exactText !== undefined && !opts.dangerouslyInteract) {
      const { exactText, ...rest } = opts;
      if (!isBoundTerminalSeat(this.db, sessionName)) return this.send(sessionName, text, rest);
      return { ...(await this.send(sessionName, exactText, { ...rest, stampISO: undefined, typedExactly: true })), envelopeOmitted: true };
    }
    const observe = () => { try { return this.compactionObserver?.(sessionName) ?? null; } catch { return null; } };
    const before = observe();
    const result = await this.sendWithoutCompactionNotice(sessionName, text, opts);
    const seen = before ? { observed: "before_send" as const, ...before } : (() => { const after = observe(); return after ? { observed: "after_send" as const, ...after } : null; })();
    if (!seen) return result;
    const when = seen.observed === "before_send" ? "when this send started" : "when this send finished";
    return { ...result, managedCompaction: { stage: seen.stage, observed: seen.observed,
      notice: `${sessionName} was ${seen.detail} (${when}, as OpenRig's managed compaction recorded it). This doesn't mean the restore has finished; if this message matters, check the reply and follow up.` } };
  }

  private async sendWithoutCompactionNotice(sessionName: string, text: string, opts?: SendOpts): Promise<SendResult> {
    if (!opts?.urgent) return this.sendClassified(sessionName, text, opts);
    // Shown on delivery, and kept with a held message: who marked it urgent.
    console.info(`[transport] urgent send to ${sessionName}, marked by ${opts.urgent.by}`);
    // An explicit prompt answer is typed as keys, and a submit-only retry types no text at all: the label's letters would
    // act as keystrokes (a menu shortcut, say). A terminal seat's exact text would run the label as a command. Their bytes
    // stay exactly as given; the mark stays in the result and the log.
    const rawKeys = opts.dangerouslyInteract === true || opts.submitOnly === true || opts.typedExactly === true;
    const result = await this.sendClassified(sessionName, rawKeys ? text : withUrgentLine(text, opts.urgent.by), opts);
    return { ...result, urgent: opts.urgent };
  }

  private async sendClassified(sessionName: string, text: string, opts?: SendOpts): Promise<SendResult> {
    const guard = this.tmuxAdapter.deliveryGuard;
    const admission: AdmissionInput = { source: opts?.openrigNotice ? "openrig" : "agent", urgent: !!opts?.urgent, override: opts?.dangerouslyInteract === true };
    if (!guard) {
      // No guard, so no recorded delivery to read back: a caller already gone ends the send here.
      if (callerSignal(opts)?.aborted) return callerCancelled(sessionName);
      const result = await this.sendUnguarded(sessionName, text, opts);
      if (result.ok && result.sent !== false) {
        await this.reconcileStartupReadiness(sessionName).catch(() => {});
      }
      return result;
    }
    const outbox = new OutboxHandler(this.db);
    let ids = opts?.committedOutboxIds ?? [opts?.deliveryId ?? `guard-send-${randomUUID()}`];
    // A combined wake's members are re-checked under the lease, against the configuration that decides this send.
    const recheck = (held: boolean) => opts?.recheckMembers?.((input) => guard.holdsInput(guard.target(sessionName).nodeId, input), held) ?? null;
    const retainedResult = (reason = "typing_guard_enabled"): SendResult => ({ ok: true, sessionName, outcome: "retained", sent: false, verified: false,
      outboxIds: ids, reason, warning: `Retained, not delivered. Inspect with rig seat held-messages ${sessionName}; changing protection does not replay held messages.` });
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
      if (callerSignal(opts)?.aborted) return callerCancelled(sessionName);
      // #1084 — the idle wait must not occupy the seat's serial lease: a long
      // --wait-for-idle inside guard.operation holds up other sends and queue
      // creates to this seat for the whole wait. The lease-free wait, main's
      // quick refusals ahead of it, and the occupant binding all live in
      // preWaitForIdle; the lease is entered only for the idle re-check +
      // write. A null return means go through guard.operation exactly as on
      // main (guard held, target unresolvable, or a quick refusal).
      let sendOpts = opts;
      if (opts?.waitForIdleMs !== undefined && !opts.submitOnly && !opts.preWaitedIdle) {
        const pre = await this.preWaitForIdle(sessionName, opts, guard);
        if (pre === null) {
          // Fall through with today's path (in-lease wait / retain / throw).
        } else if (!pre.ok) {
          return pre.failure;
        } else {
          // Occupant check (review round 3): the lease starts only after the
          // pre-wait, so refuse here when the seat changed hands meanwhile —
          // exactly as main refuses with guard_target_changed. Retention must
          // not adopt the new occupant either, so this runs before operation.
          const current = guard.target(sessionName);
          if (JSON.stringify(pre.bound) !== JSON.stringify(current)) {
            return {
              ok: false,
              sessionName,
              sent: false,
              reason: "guard_target_changed",
              error: "Input target/occupant changed; no input written.",
              activity: pre.evidence.activity,
              waitedMs: pre.evidence.waitedMs,
              attempts: pre.evidence.attempts,
            };
          }
          sendOpts = { ...opts, preWaitedIdle: pre.evidence, preWaitBound: pre.bound };
        }
      }
      const result = await guard.operation(sessionName, async () => {
        const members = recheck(false);
        const memberText = members?.text ?? text;
        const memberOpts = members ? { ...sendOpts, committedOutboxIds: members.outboxIds } : sendOpts;
        if (this.guardedDelivery && !memberOpts?.submitOnly && !memberOpts?.dangerouslyInteract && guard.needsInputCheck(sessionName)) {
          if (callerSignal(memberOpts)?.aborted) return callerCancelled(sessionName);
          return this.guardedDelivery.send(sessionName, memberText, memberOpts ?? {},
            memberOpts?.committedOutboxIds ?? [`guard-send-${randomUUID()}`]);
        }
        return this.sendUnguarded(sessionName, memberText, memberOpts);
      }, async target => {
        if (opts?.submitOnly) return { ok: false, sessionName, sent: false, reason: "typing_guard_enabled", error: "Typing guard prevents submit-only; no Enter was sent." };
        // Nothing is retained yet: a caller that went away while this send waited for the lease ends it here.
        if (callerSignal(opts)?.aborted) return callerCancelled(sessionName);
        const members = recheck(true);
        if (members) ids = members.outboxIds;
        this.db.transaction(() => {
          for (const id of ids) {
            const prior = opts?.committedOutboxIds ? outbox.getById(id) : null;
            if (opts?.committedOutboxIds && (!prior || prior.destinationSession !== sessionName)) throw new Error("Committed wake target/ID mismatch");
            outbox.retain(prior ? { ...prior, outboxId: id, tags: prior.tags ?? undefined, auditPointer: prior.auditPointer ?? undefined } : {
              outboxId: id, senderSession: opts?.actorSession ?? "unknown", destinationSession: sessionName, body: text, auditPointer: opts?.auditPointer,
              identityProvenance: opts?.identityProvenance, ...(opts?.urgent ? { urgency: "urgent" } : {}),
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
      }, admission);
      if (result.ok && result.sent !== false) {
        await this.reconcileStartupReadiness(sessionName).catch(() => {});
      }
      return result;
    } catch (error) {
      // A refusal thrown after the text was written (for example a guard check before Enter) is not "nothing sent".
      if ((error as { inputWritten?: boolean }).inputWritten === true) {
        // Only a throw before the Enter key reached the adapter positively means Enter was never sent.
        const enter = (error as { enterAttempted?: boolean }).enterAttempted === true ? "the submission (Enter) outcome is unconfirmed" : "Enter was not sent";
        return { ok: false, sessionName, sent: true, outcome: "failed", inputPhase: "written", reason: (error as { code?: string }).code ?? "submit_refused",
          error: `Text was written to '${sessionName}' but ${enter}: ${(error as Error).message}` };
      }
      // A throw after the text write was issued: whether it landed is unknown, so it is not "nothing sent" either.
      if ((error as { inputAttempted?: boolean }).inputAttempted === true) {
        return { ok: false, sessionName, outcome: "failed", inputPhase: "attempted", reason: (error as { code?: string }).code ?? "delivery_indeterminate",
          error: `A text write to '${sessionName}' was issued, but its result was lost: ${(error as Error).message}` };
      }
      return { ok: false, sessionName, sent: false, reason: (error as { code?: string }).code ?? "guard_unavailable", error: (error as Error).message };
    }
  }

  /**
   * #1084/#1103: lease-free idle wait before the serial lease, so a long
   * --wait-for-idle holds up no other send or queue create to this seat.
   * Returns the wait evidence plus the occupant bound before the wait (both
   * threaded into the leased send), a failure result using main's exact
   * reasons, or null when the send must go through guard.operation exactly
   * as on main. Order matters: typing-guard decision first, then main's
   * quick refusals (runtime identity, wait validations, session probe),
   * then the wait. Only the lookups sit inside try: a late throw surfaces
   * instead of silently running a second full wait inside the lease.
   */
  private async preWaitForIdle(
    sessionName: string,
    opts: SendOpts,
    guard: SeatDeliveryGuard,
  ): Promise<
    | { ok: true; evidence: NonNullable<SendOpts["preWaitedIdle"]>; bound: GuardTarget }
    | { ok: false; failure: SendResult }
    | null
  > {
    const timeoutMs = opts.waitForIdleMs;
    if (timeoutMs === undefined) return null;
    let meta: {
      runtime: string | null; attachmentType: string | null; nodeId: string | null;
      pane: string | null; occupant: string | null; resumeToken: string | null;
    };
    let bound: GuardTarget;
    try {
      const preTarget = guard.maybeTarget(sessionName);
      if (!preTarget) return null;
      const prePref = guard.preference(preTarget.nodeId);
      // Hold mode retains in the lease, and draft-aware mode reads the input there first and returns its
      // immediate result (held, or refused with its reason): neither takes the lease-free wait. A
      // draft-aware send whose input is empty waits for idle inside the lease, as before this wait existed.
      if (prePref.effective || prePref.desired || prePref.desiredMode === "draft-aware" || prePref.effectiveMode === "draft-aware") return null;
      meta = this.getSessionMeta(sessionName);
      bound = guard.target(sessionName);
      sessionName = bound.session;
    } catch {
      return null;
    }
    // External CLI seats never wait: main refuses them before anything else,
    // and a probe or wait would only delay that refusal (or mistake it for
    // an absent session).
    if (meta.attachmentType === "external_cli") {
      return { ok: false, failure: {
        ok: false,
        sessionName,
        reason: "transport_unavailable",
        error: `Session '${sessionName}' is attached as an external CLI node. Inbound tmux transport is unavailable for this target.`,
      } };
    }
    const runtime = meta.runtime;
    if (runtime && runtime !== "terminal" && runtime !== "claude-code") {
      const unverified = await this.unverifiedShellForeground(sessionName, runtime, meta.pane, meta.resumeToken);
      if (unverified) {
        return { ok: false, failure: {
          ok: false,
          sessionName,
          sent: false,
          reason: "target_runtime_unverified",
          error: `Refused: '${sessionName}' reports ${unverified} as the foreground command, but OpenRig could not verify its expected ${runtime} agent in the bound pane. The agent may still be running behind a wrapper. No text was sent.`,
        } };
      }
    }
    if (opts.force) {
      return { ok: false, failure: {
        ok: false,
        sessionName,
        reason: "invalid_wait_for_idle",
        error: "--wait-for-idle cannot be combined with force. No text was sent.",
        sent: false,
      } };
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { ok: false, failure: {
        ok: false,
        sessionName,
        reason: "invalid_wait_for_idle",
        error: "waitForIdleMs must be a positive number. No text was sent.",
        sent: false,
      } };
    }
    try {
      const target = this.absenceProbeTarget(sessionName);
      const observedAt = this.now().toISOString();
      const probe = await this.tmuxAdapter.probeSession(sessionName);
      if (probe.state === "absent") {
        this.recordSessionMissingVerdict(target, observedAt);
        return { ok: false, failure: {
          ok: false,
          sessionName,
          reason: "session_missing",
          error: `Session '${sessionName}' not found: tmux reports no session with this name. No text was sent. Check available sessions with: rig ps --nodes`,
        } };
      }
      if (probe.state === "transport_unavailable") {
        return { ok: false, failure: {
          ok: false,
          sessionName,
          reason: "tmux_unavailable",
          error: `The tmux server could not be reached (${probe.cause}). Whether session '${sessionName}' exists was not determined. No text was sent.`,
        } };
      }
    } catch (err) {
      return { ok: false, failure: {
        ok: false,
        sessionName,
        reason: "tmux_unavailable",
        error: `The tmux session probe failed unexpectedly (${err instanceof Error ? err.message : String(err)}). Whether session '${sessionName}' exists was not determined. No text was sent.`,
      } };
    }
    const deadlineAt = Date.now() + timeoutMs;
    const preWait = await this.waitForIdle({
      sessionName,
      runtime: meta.runtime,
      attachmentType: meta.attachmentType,
      timeoutMs,
      binding: { sessionName, nodeId: meta.nodeId, occupant: meta.occupant, pane: meta.pane },
      privateInput: opts.dangerouslyInteract === true,
      readinessFromPaneOnly: opts.readinessFromPaneOnly === true,
      postCompactTurnBoundary: opts.postCompactTurnBoundary === true,
      signal: callerSignal(opts), cancelledBy: "caller",
    });
    if (!preWait.ok) {
      return { ok: false, failure: {
        ok: false,
        sessionName,
        reason: preWait.reason,
        error: preWait.error,
        sent: false,
        inputPhase: "not_reached",
        activity: preWait.activity,
        waitedMs: preWait.waitedMs,
        attempts: preWait.attempts,
      } };
    }
    return { ok: true, evidence: { activity: preWait.activity, waitedMs: preWait.waitedMs, attempts: preWait.attempts, deadlineAt }, bound };
  }

  private async sendUnguarded(sessionName: string, text: string, opts?: SendOpts): Promise<SendResult> {
    sessionName = physicalSessionName(this.db, sessionName);
    let preVerifyContent: string | null = null;
    const sessionMeta = this.getSessionMeta(sessionName);
    const runtime = sessionMeta.runtime;
    const readTarget = sessionMeta.pane ?? sessionName;
    let runtimeAdvisory: string | undefined;
    const bindingChanged = () => JSON.stringify(this.getSessionMeta(sessionName)) !== JSON.stringify(sessionMeta);
    const changedRecipient = (sent = false): SendResult => ({ ok: false, sessionName, sent, reason: "target_runtime_conflict",
      error: sent ? "Recipient binding changed after paste; Enter was not sent." : "Recipient binding changed; no text was sent." });
    const checkClaudeTarget = async (): Promise<SendResult | null> => {
      if (runtime !== "claude-code") return null;
      if (bindingChanged()) return changedRecipient();
      const observation = await this.claudeDeliveryObservation(sessionName, sessionMeta.pane, sessionMeta.resumeToken, sessionMeta.rotation);
      if (bindingChanged()) return changedRecipient();
      if (observation.state === "idle_shell" || observation.state === "conflict") {
        return { ok: false, sessionName, sent: false, reason: observation.state === "idle_shell" ? "target_runtime_not_running" : "target_runtime_conflict",
          error: `Refused: ${observation.detail}. No text was sent.` };
      }
      if (observation.state === "unknown") runtimeAdvisory = `runtime: ${observation.detail}; delivery proceeds without verified native identity.`;
      return null;
    };
    // #331: with mouse on, scrolling a seat pane puts it in tmux copy mode. A paste still reaches
    // the input there, but copy mode swallows the Enter, so the send would report ok while the
    // text sits unsubmitted. Leave the mode once (send-keys -X cancel) and deliver; fail before
    // typing anything only if the pane still reads as in a mode. An unknown answer keeps today's path.
    const readPaneInMode = async (): Promise<boolean | null> => {
      try {
        return typeof this.tmuxAdapter.isPaneInMode === "function" ? await this.tmuxAdapter.isPaneInMode(readTarget) : null;
      } catch { return null; }
    };
    const leavePaneMode = async (outcome: string): Promise<SendResult | null> => {
      if (await readPaneInMode() !== true) return null;
      try {
        if (typeof this.tmuxAdapter.cancelPaneMode === "function") await this.tmuxAdapter.cancelPaneMode(readTarget);
      } catch { /* the re-read below decides */ }
      if (await readPaneInMode() !== true) return null;
      return { ok: false, sessionName, sent: false, reason: "pane_in_mode",
        error: `'${sessionName}' is in a tmux mode (such as copy mode) and could not leave it, so Enter would not reach the agent. ${outcome}` };
    };
    // S01/S02 P2 observation context, frozen at attempt entry before any await.
    const observed = this.captureObserver && !opts?.dangerouslyInteract ? {
      attemptId: randomUUID(),
      binding: Object.freeze({ sessionName, nodeId: sessionMeta.nodeId, occupant: sessionMeta.occupant, pane: sessionMeta.pane }),
      pre: (opts?.verify ? { state: "not_reached" } : { state: "not_requested" }) as CaptureSlot,
      post: (opts?.verify ? { state: "not_reached" } : { state: "not_requested" }) as CaptureSlot,
      sentHash: null as string | null,
    } : null;
    let existingInput: ExistingInput | undefined;
    let overrideBeforePaste: (() => Promise<void>) | undefined;
    const observe = (result: SendResult): SendResult => {
      if (existingInput) result = { ...result, existingInput };
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
      const target = this.absenceProbeTarget(sessionName);
      const observedAt = this.now().toISOString();
      const probe = await this.tmuxAdapter.probeSession(sessionName);
      if (probe.state === "absent") {
        this.recordSessionMissingVerdict(target, observedAt);
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
          const evidence = startupSubmissionEvidence(pane, expected, opts.submitOnlyCaptureLines ?? 50, runtime);
          if (evidence) opts.onStartupMismatch(evidence);
        } catch { /* Observation has no delivery authority. */ }
      };
      let pane: string | null;
      try {
        pane = await this.runStage(
          "session_transport.submit_only_precheck",
          () => this.tmuxAdapter.capturePaneContent(readTarget, opts.submitOnlyCaptureLines ?? 50),
        );
      } catch (error) {
        recordMismatch(null);
        throw error; // Preserve the existing guarded/unguarded error handling.
      }
      const staged = opts.requireFullStagedText
        ? inspectStartupStagedText(pane, expected, runtime) === "staged"
        : hasExpectedStagedText(pane, expected, runtime);
      if (!staged) {
        recordMismatch(pane);
        return {
          ok: false,
          sessionName,
          reason: "staged_mismatch",
          error: `submitOnly refused: the pane of '${sessionName}' does not show the expected staged text — pressing Enter here could drive something else entirely. Nothing was submitted.`,
        };
      }
      this.tmuxAdapter.deliveryGuard?.expectStagedInput(sessionName, expected);
      // This Enter is the request's first input, so a caller that has gone ends it here, before any key, as for a paste.
      const cancel = callerSignal(opts);
      if (cancel?.aborted) return callerCancelled(sessionName);
      const targetFailure = await checkClaudeTarget();
      if (targetFailure) return targetFailure;
      const copyModeFailure = await leavePaneMode("Nothing was submitted.");
      if (copyModeFailure) return copyModeFailure;
      if (cancel?.aborted) return callerCancelled(sessionName);
      // The last check runs in the adapter, immediately before the key (after its guard checks).
      const beforeKey = cancel ? () => { if (cancel.aborted) throw new DeliveryGuardError(CALLER_CANCELLED, "caller cancelled before the key"); } : undefined;
      let submitResult;
      try {
        submitResult = await this.runStage(
          "session_transport.submit",
          () => beforeKey ? this.tmuxAdapter.sendKeys(sessionName, ["Enter"], beforeKey) : this.tmuxAdapter.sendKeys(sessionName, ["Enter"]),
          (result) => result.ok ? "ok" : "failed",
        );
      } catch (error) {
        // Unguarded, the adapter's pre-key check throws instead of returning a result; no key was sent.
        if (error instanceof DeliveryGuardError && error.code === CALLER_CANCELLED && cancel?.aborted) return callerCancelled(sessionName);
        throw error;
      }
      if (!submitResult.ok && submitResult.code === CALLER_CANCELLED && cancel?.aborted) return callerCancelled(sessionName);
      if (!submitResult.ok) {
        return { ok: false, sessionName, reason: "submit_failed", outcome: "failed", error: `submitOnly: Enter did not land on '${sessionName}': ${submitResult.message}` };
      }
      try { opts.onInputEffect?.("submitted"); } catch { /* Observation cannot change an input result. */ }
      return observe({ ok: true, sessionName, outcome: "rendered-unconfirmed", submitOnly: true });
    }

    // #1084: when send() already waited lease-free (preWaitedIdle), the wait
    // below is skipped; otherwise wait here, exactly as before
    // (typing-guard flip and unresolvable-target races keep today's behavior).
    if (waitForIdleMs !== undefined && !opts?.preWaitedIdle) {
      const waitResult = await this.waitForIdle({
        sessionName,
        runtime,
        attachmentType: sessionMeta.attachmentType,
        timeoutMs: waitForIdleMs,
        binding: observed?.binding,
        privateInput: opts?.dangerouslyInteract === true,
        readinessFromPaneOnly: opts?.readinessFromPaneOnly === true,
        postCompactTurnBoundary: opts?.postCompactTurnBoundary === true,
        signal: callerSignal(opts), cancelledBy: "caller",
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
          inputPhase: "not_reached",
          ...waitEvidence,
        };
      }
    } else if (opts?.preWaitedIdle && waitForIdleMs !== undefined) {
      // Occupant check (review round 3): the lease started only after the
      // pre-wait, so refuse when the seat changed hands meanwhile, exactly
      // as main refuses with guard_target_changed. No new refusal.
      const preGuard = this.tmuxAdapter.deliveryGuard;
      if (preGuard && opts.preWaitBound) {
        const current = preGuard.target(sessionName);
        if (JSON.stringify(opts.preWaitBound) !== JSON.stringify(current)) {
          return {
            ok: false,
            sessionName,
            sent: false,
            reason: "guard_target_changed",
            error: "Input target/occupant changed; no input written.",
            activity: opts.preWaitedIdle.activity,
            waitedMs: opts.preWaitedIdle.waitedMs,
            attempts: opts.preWaitedIdle.attempts,
          };
        }
      }
      // Idle re-check (review round 1 + bot round 2): the wait-mode contract
      // holds at type time too — only idle types. The budget is measured
      // from the ORIGINAL deadline (lease-queue time counts too), so the
      // total wait never exceeds what the caller asked for. Below one poll
      // interval, waiting buys nothing: one unraced observation decides, so
      // an idle seat at a dead budget still sends instead of losing a race
      // against a zero timer.
      const preEvidence = opts.preWaitedIdle;
      const deadlineRemainingMs = preEvidence.deadlineAt - Date.now();
      if (deadlineRemainingMs > this.waitForIdlePollMs) {
        const rewait = await this.waitForIdle({
          sessionName,
          runtime,
          attachmentType: sessionMeta.attachmentType,
          timeoutMs: deadlineRemainingMs,
          // Message-only: the re-wait runs on the leftover budget, but the
          // timeout names the configured --wait-for-idle value.
          timeoutLabelMs: waitForIdleMs,
          privateInput: opts.dangerouslyInteract === true,
          binding: observed?.binding,
          readinessFromPaneOnly: opts.readinessFromPaneOnly === true,
          postCompactTurnBoundary: opts.postCompactTurnBoundary === true,
          signal: callerSignal(opts), cancelledBy: "caller",
        });
        waitEvidence = {
          activity: rewait.activity,
          waitedMs: preEvidence.waitedMs + rewait.waitedMs,
          attempts: preEvidence.attempts + rewait.attempts,
        };
        if (!rewait.ok) {
          return {
            ok: false,
            sessionName,
            reason: rewait.reason,
            error: rewait.error,
            sent: false,
            inputPhase: "not_reached",
            ...waitEvidence,
          };
        }
      } else {
        const recheck = await this.classifySendReadiness({
          sessionName,
          runtime,
          attachmentType: sessionMeta.attachmentType,
          binding: observed?.binding,
          readinessFromPaneOnly: opts.readinessFromPaneOnly === true,
          postCompactTurnBoundary: opts.postCompactTurnBoundary === true,
        }, opts.dangerouslyInteract === true);
        if (recheck.state !== "idle") {
          const late: { reason: string; error: string } =
            recheck.state === "needs_input"
              ? {
                  reason: "target_needs_input",
                  error: `Refused: '${sessionName}' is at an interactive prompt (${recheck.reason}). A message must not select or approve it. To deliberately drive the prompt: rig send ${sessionName} "<text>" --dangerously-interact --reason "<why>".${clearAttentionHint(sessionName, recheck.reason)} No text was sent.`,
                }
              : recheck.state === "unknown"
                ? {
                    reason: "target_activity_unknown",
                    error: `Target activity could not be determined (${recheck.reason}) when the ${waitForIdleMs}ms wait ended. No text was sent.`,
                  }
                : {
                    reason: "wait_for_idle_timeout",
                    error: `Target was still busy (${recheck.reason}) when the ${waitForIdleMs}ms wait ended. No text was sent.`,
                  };
          return {
            ok: false,
            sessionName,
            sent: false,
            inputPhase: "not_reached",
            reason: late.reason,
            error: late.error,
            activity: recheck,
            waitedMs: preEvidence.waitedMs,
            attempts: preEvidence.attempts + 1,
          };
        }
        waitEvidence = {
          activity: recheck,
          waitedMs: preEvidence.waitedMs,
          attempts: preEvidence.attempts + 1,
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
    // Broadcast can carry wait + override: after waiting, it still uses the same deliberate-input boundary.
    const promptOverride = Boolean(opts?.dangerouslyInteract);
    if (waitForIdleMs === undefined || promptOverride) {
      const readiness = await this.classifySendReadiness({
        sessionName,
        runtime,
        attachmentType: sessionMeta.attachmentType,
        binding: observed?.binding,
      }, opts?.dangerouslyInteract === true);

      // Explicit interaction selects key input even when readiness cannot recognize the prompt.
      // Only bypassing a positive picker requires a successful audit; other states already sent.
      if (opts?.dangerouslyInteract) {
        if (readiness.state === "needs_input" && (!opts.reason || opts.reason.trim().length === 0)) {
          return {
            ok: false,
            sessionName,
            reason: "dangerously_interact_requires_reason",
            error: "--dangerously-interact requires --reason explaining why the prompt is being driven. No text was sent.",
          };
        }
        const auditInput = { sessionName, readiness, actorSession: opts.actorSession ?? null, overrideReason: opts.reason ?? null };
        const target = this.tmuxAdapter.deliveryGuard?.maybeTarget(sessionName);
        // Native menus retain their audited key-driving path. Otherwise inspect under the same lease,
        // after buffer preparation, immediately before the adapter's final identity check and paste.
        if (target && readiness.state !== "needs_input") {
          overrideBeforePaste = async () => {
            const unchecked = opts.typeWithoutChecking === true;
            const snapshot = unchecked ? null : await this.readWithinDeadline("session_transport.override_input",
              () => this.tmuxAdapter.captureComposerSnapshot(target.pane ?? sessionName));
            const input = unchecked ? null : inspectComposerInput(snapshot, runtime);
            const classification: ExistingInput["classification"] = unchecked ? "not_checked" : input!.state === "unknown" ? "unreadable"
              : input!.state === "text" ? "typed_or_pasted" : input!.ghost ? "suggestion_only" : "empty";
            existingInput = { target, classification, rows: input?.rows ?? [], suggestionRows: input?.suggestionRows ?? [],
              cursor: input?.cursor ?? null, fullContentsVisible: !!input && input.state !== "unknown" && !input.collapsedPaste,
              ...(input?.unknownReason ? { reason: input.unknownReason } : {}), cleared: false };
            const stopped = classification === "typed_or_pasted" || classification === "unreadable";
            const audit = this.recordPromptOverride({ ...auditInput, input: { classification, visibleRows: existingInput.rows.length,
              suggestionRows: existingInput.suggestionRows.length, choice: unchecked ? "type_without_checking" : "inspect",
              outcome: stopped ? "stopped" : "proceed", clearAttempted: false } });
            if (!audit.ok) sendAdvisory = `prompt-override: audit unavailable (${audit.reason}).`;
            if (stopped) throw new DeliveryGuardError(classification === "unreadable" ? "override_input_unknown" : "override_input_present",
              classification === "unreadable" ? "Input could not be read. Nothing was typed. Inspect the native terminal, deliberately clear its prompt with native/tmux controls, then retry; or explicitly choose --type-without-checking (does not clear)."
                : "Existing typed or pasted input (author unknown). Nothing was typed. Inspect the shown input, deliberately clear the prompt with native/tmux controls, then retry. Manual clearing is outside OpenRig's lease and observation checks and is not recorded.");
            if (unchecked) sendAdvisory = [sendAdvisory, "Input was not checked or cleared; this send may join or submit existing text."].filter(Boolean).join(" ");
          };
        }
        const audit = overrideBeforePaste ? { ok: true as const } : this.recordPromptOverride(auditInput);
        if (!audit.ok && readiness.state === "needs_input") {
          return {
            ok: false,
            sessionName,
            reason: "prompt_override_audit_unavailable",
            activity: readiness,
            error: `Refused: --dangerously-interact requires an auditable override record, which could not be persisted (${audit.reason}). No text was sent.`,
          };
        }
        if (!audit.ok) sendAdvisory = "prompt-override: audit unavailable (" + audit.reason + "); input sent anyway.";
      }
      if (readiness.state === "needs_input") {
        if (!promptOverride) {
          return {
            ok: false,
            sessionName,
            reason: "target_needs_input",
            activity: readiness,
            error: `Refused: '${sessionName}' is at an interactive prompt (${readiness.reason}). A message must not select or approve it. To deliberately drive the prompt: rig send ${sessionName} "<text>" --dangerously-interact --reason "<why>".${clearAttentionHint(sessionName, readiness.reason)} No text was sent.`,
          };
        }
      } else if (readiness.state === "unknown") {
        // OPR.0.4.3.28 correction — INVERT the fail-closed-on-unknown default. Absent/stale/failed
        // telemetry is NOT positive picker evidence, so the send PROCEEDS. Diagnose the producer link
        // and carry it as a NON-blocking advisory (`warning` on the success result) — ALWAYS, whether
        // or not --dangerously-interact was passed (B1 code-review fix) — so the honest telemetry is
        // surfaced without ever blocking communication. Hooks are advisory telemetry, not authority
        // over whether agents can talk.
        if (readiness.reason === OPENCLAW_TURN_NOT_RECOVERED) {
          sendAdvisory = [sendAdvisory, `OpenClaw refused its last local turn and OpenRig hasn't recovered it; this message submits a new turn. Inspect it with rig capture ${sessionName}.`].filter(Boolean).join(" ");
        } else {
          const linkDiagnosis = await this.diagnoseProducerLink(sessionName);
          sendAdvisory = [sendAdvisory, `producer-link: ${linkDiagnosis} — activity could not be determined (${readiness.reason}); sent anyway (telemetry is advisory).`].filter(Boolean).join(" ");
        }
        // fall through to the send below.
      } else if (readiness.state === "running") {
        // OPR.0.4.3.28 fast-follow (advisor audit-catch, pm-ruled a founder-principle residual):
        // busy is NOT a block. Downgrade the old mid_work HARD REFUSE to a non-blocking advisory —
        // attach it on the success result + PROCEED (mirrors the unknown inversion). --force is now a
        // no-op here (the option is kept for back-compat). needs_input (positive picker) remains the
        // ONLY hard refuse; unknown/stale/missing already proceed-with-advisory above.
        sendAdvisory = [sendAdvisory, "target pane appears mid-task; sent anyway (busy is advisory, not a block)."].filter(Boolean).join(" ");
        if (runtime === "codex") sendAdvisory += " This message joins its running turn and may redirect it. For separate work, create a queue row (rig queue create --destination <seat>): a saved row keeps the work apart from the short wake typed into the seat. To watch the result, --wait-for-idle <seconds> sends only once the seat is idle, and sends nothing if it isn't when the wait ends.";
        // fall through to the send below.
      }
      // idle (or running/unknown — now advisory-and-proceed) → proceed to send.
    }

    // transport.verify_input_box: a verified Claude Code or Codex send reports on input-box evidence. The
    // setting is read only for those sends; everything else keeps today's path.
    const inputBoxRuntime = opts?.verify && (runtime === "claude-code" || runtime === "codex") && this.inputBoxSettingOn()
      ? runtime : null;

    if (opts?.verify) {
      const captureSeq = observed ? nextCaptureSeq++ : 0;
      try {
        preVerifyContent = await this.runStage(
          "session_transport.pre_capture",
          () => runtime === "terminal" || !verificationSnippet(text).envelope ? this.tmuxAdapter.capturePaneContent(readTarget, 30)
            : this.tmuxAdapter.capturePaneContent(readTarget, 30, { joinWrappedLines: true }),
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

    // A caller that went away while this send waited: nothing has been written, so nothing ever is.
    if (callerSignal(opts)?.aborted) return observe({ ...callerCancelled(sessionName), ...(waitMode ? waitEvidence : {}) });
    // Recheck the selected recipient after readiness/capture awaits, at the input boundary.
    const targetFailure = await checkClaudeTarget();
    if (targetFailure) return observe(targetFailure);
    const copyModeFailure = await leavePaneMode("No text was sent.");
    if (copyModeFailure) return observe({ ...copyModeFailure, ...(waitMode ? waitEvidence : {}) });

    // 3. Deliver ordinary messages as paste, audited prompt answers as key input.
    if (observed) observed.sentHash = hashSentText(text);
    // The caller's cancellation is checked once more at the adapter's last step before the paste (after its buffer
    // setup). A refusal there is proven pre-input and returns caller_cancelled; Enter below never checks it.
    const cancel = callerSignal(opts);
    if (cancel?.aborted) return observe({ ...callerCancelled(sessionName), ...(waitMode ? waitEvidence : {}) });
    const beforePaste = cancel ? () => { opts?.beforeWrite?.(); if (cancel.aborted) throw new DeliveryGuardError(CALLER_CANCELLED, "caller cancelled before the paste"); } : opts?.beforeWrite;
    // Set once the text write has been handed to the adapter: from then on a throw is not "nothing sent".
    let writeIssued = false;
    const tagIssued = (error: unknown): never => {
      if (writeIssued && error && typeof error === "object") (error as { inputAttempted?: boolean }).inputAttempted = true;
      throw error;
    };
    const textResult = await this.runStage(
      "session_transport.send_text",
      () => {
        opts?.beforeWrite?.();
        writeIssued = true;
        if (promptOverride) return this.tmuxAdapter.sendText(sessionName, text, beforePaste, { bracketed: false, beforePaste: overrideBeforePaste });
        return beforePaste ? this.tmuxAdapter.sendText(sessionName, text, beforePaste) : this.tmuxAdapter.sendText(sessionName, text);
      },
      (result) => result.ok ? "ok" : "failed",
    ).catch(tagIssued);
    if (!textResult.ok && textResult.code === CALLER_CANCELLED && cancel?.aborted) {
      return observe({ ...callerCancelled(sessionName), ...(waitMode ? waitEvidence : {}) });
    }
    if (!textResult.ok) {
      // A draft refusal is the guard holding the write before any input; it is not an attempted write.
      const policyRefusal = typeof textResult.code === "string" && (textResult.code.startsWith("draft_") || textResult.code.startsWith("override_input_") || textResult.code === "managed_compaction_pending");
      return observe({
        ok: false,
        sessionName,
        reason: policyRefusal ? textResult.code : "send_failed",
        outcome: "failed",
        // The adapter's draft checks run before the paste (only file/buffer preparation precedes them), and its
        // after-paste observation cannot fail the write, so a draft_* receipt proves the target input was never reached.
        inputPhase: policyRefusal ? "not_reached" as const : "attempted" as const,
        error: `Failed to send text to '${sessionName}': ${textResult.message}`,
        ...(waitMode || policyRefusal ? { sent: false, ...waitEvidence } : {}),
      });
    }
    try { opts?.onInputEffect?.("pasted"); } catch { /* Observation cannot change a completed paste. */ }

    // From the successful paste to Enter the text may sit in the seat's input. Any throw in this span is
    // tagged inputWritten, so no caller reports it as unsent; a step added here later stays covered.
    let boxBefore: { seat: SeatReading; reading: InputBoxReading; pid: number | null; pane: string | null } | null = null;
    let submitResult;
    let enterIssued = false; // set as the Enter key is handed to the adapter
    try {
      // 4. Wait 200ms (spike-proven delay)
      await this.sleep(200);

      // With transport.verify_input_box on, one bounded read of the input box and its pane process before
      // Enter (a 500 ms budget after the 200 ms wait). It only reports: nothing here decides whether Enter is sent.
      // The seat is read from the existing --verify capture taken before the paste (the whole screen); no new read.
      if (inputBoxRuntime && !promptOverride) {
        const read = await this.readWithinDeadline("session_transport.input_box_capture", () => Promise.all([
          this.tmuxAdapter.getPanePid(readTarget).catch(() => null),
          this.tmuxAdapter.capturePaneContent(readTarget, 30).catch(() => null),
        ]));
        boxBefore = { seat: readSeatBeforePaste(preVerifyContent, inputBoxRuntime, sessionName),
          reading: readInputBox(read?.[1] ?? null, inputBoxRuntime, text), pid: read?.[0] ?? null, pane: read?.[1] ?? null };
      }

      if (runtime === "claude-code" && bindingChanged()) return observe(changedRecipient(true));

      if (promptOverride) {
        const pane = await this.runStage("session_transport.prompt_override_pre_submit_capture",
          () => this.tmuxAdapter.capturePaneContent(readTarget, 50)).catch(() => null);
        if (runtime === "claude-code" && bindingChanged()) return observe(changedRecipient(true));
        if (!promptAnswerStaged(pane, text, runtime)) {
          return observe({ ok: true, sessionName, sent: true, verified: false, outcome: "rendered-unconfirmed", promptInteraction: "unverified",
            warning: [sendAdvisory, "prompt-override: answer sent as unbracketed input; submission unverified. No trailing Enter: the complete answer is not visibly staged (it may have been consumed, the prompt changed, or observation is unavailable)."].filter(Boolean).join(" ") });
        }
        sendAdvisory = [sendAdvisory, "prompt-override: answer sent as unbracketed input; Enter submitted the complete still-staged answer."].filter(Boolean).join(" ");
      }

      // 5. Submit (Enter)
      submitResult = await this.runStage(
        "session_transport.submit",
        () => { opts?.beforeWrite?.(); enterIssued = true; return opts?.beforeWrite ? this.tmuxAdapter.sendKeys(sessionName, ["Enter"], opts.beforeWrite) : this.tmuxAdapter.sendKeys(sessionName, ["Enter"]); },
        (result) => result.ok ? "ok" : "failed",
      );
      if (!submitResult.ok) {
        const policyRefusal = typeof submitResult.code === "string" && (submitResult.code.startsWith("draft_") || submitResult.code === "managed_compaction_pending");
        return observe({
          ok: false,
          sessionName,
          reason: policyRefusal ? submitResult.code : "submit_failed",
          outcome: "failed",
          inputPhase: "written",
          error: policyRefusal
            ? `Text was pasted into '${sessionName}', but Enter was not sent: ${submitResult.message} Inspect the current input before submitting it.`
            : `Text is in '${sessionName}', but the Enter reported a failure, so the submission outcome is unconfirmed. The agent may need manual attention.`,
          ...(waitMode || policyRefusal ? { sent: true, ...waitEvidence } : {}),
        });
      }
    } catch (error) {
      if (error && typeof error === "object") Object.assign(error, { inputWritten: true, enterAttempted: enterIssued });
      throw error;
    }
    try { opts?.onInputEffect?.("submitted"); } catch { /* Observation cannot change a completed submission. */ }

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
          () => runtime === "terminal" || !verificationSnippet(text).envelope ? this.tmuxAdapter.capturePaneContent(readTarget, 30)
            : this.tmuxAdapter.capturePaneContent(readTarget, 30, { joinWrappedLines: true }),
        );
        if (observed) observed.post = captureSlot(content, this.now().toISOString(), captureSeq);
        // A terminal prompt is command history, not an agent composer. Preserve
        // its original prefix-count verification even while a command is running.
        const terminal = runtime === "terminal";
        const { snippet, envelope } = terminal ? { snippet: text.slice(0, 40), envelope: false } : verificationSnippet(text);
        // Only Codex gains »; all other runtimes keep the existing boundaries.
        const promptClass = runtime === "codex" ? COMPOSER_PROMPT_CLASS : "❯›";
        const transcript = terminal ? (pane: string | null) => pane ?? ""
          : (pane: string | null) => envelope ? verificationTranscript(pane, promptClass)
            : normalizeVerificationText(verificationTranscript(pane, promptClass));
        const count = envelope ? (pane: string, expected: string) => countEnvelopeOccurrences(pane, expected, promptClass) : countOccurrences;
        const preCount = count(transcript(preVerifyContent), snippet);
        const postCount = count(transcript(content), snippet);
        // An audited prompt answer reads no box (no extra read is added for it), so it reads unconfirmed; it never
        // falls back to the count below.
        const inputBox = boxBefore && inputBoxRuntime
          ? await this.inputBoxEvidence(sessionName, readTarget, sessionMeta, boxBefore, readInputBox(content, inputBoxRuntime, text, boxBefore.pane))
          : undefined;
        // With the setting on, only a seat proven idle before the paste and input-box evidence verify: exact before
        // Enter, empty after, same process. A not-idle or unknown seat always reads unconfirmed.
        const verified = inputBoxRuntime
          ? inputBox?.seat === "idle" && inputBox.before === "exact" && inputBox.after === "empty" && inputBox.sameProcess
          : postCount > preCount;
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

  private inputBoxSettingOn(): boolean {
    try { return this.verifyInputBox?.() === true; } catch { return false; }
  }

  /** One input-box read, timed by the slow-op recorder and raced against the deadline. Null on timeout or
   *  error; an abandoned read is ignored. A read never decides whether Enter is sent. */
  private async readWithinDeadline<T>(site: string, read: () => Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = this.runStage(site, read);
      pending.catch(() => undefined);
      return await Promise.race([
        pending,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), INPUT_BOX_READ_DEADLINE_MS); }),
      ]);
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** After the post-Enter capture: the same pane process (pid read before Enter and now) and the same binding. */
  private async inputBoxEvidence(
    sessionName: string,
    paneTarget: string,
    meta: { nodeId: string | null; pane: string | null; occupant: string | null },
    before: { seat: SeatReading; reading: InputBoxReading; pid: number | null },
    after: InputBoxReading,
  ): Promise<InputBoxEvidence> {
    const pid = await this.readWithinDeadline("session_transport.input_box_pane_pid", () => this.tmuxAdapter.getPanePid(paneTarget));
    let sameBinding = false;
    try {
      const now = this.getSessionMeta(sessionName);
      sameBinding = now.nodeId === meta.nodeId && now.pane === meta.pane && now.occupant === meta.occupant;
    } catch { /* unknown binding is not the same binding */ }
    return { seat: before.seat, before: before.reading, after, sameProcess: before.pid !== null && pid !== null && pid === before.pid && sameBinding };
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
    /** Whose cancellation the signal carries: managed preparation (the default) or the send's caller. */
    cancelledBy?: "caller";
    privateInput?: boolean;
    binding?: ObservedBinding;
    readinessFromPaneOnly?: boolean;
    postCompactTurnBoundary?: boolean;
    // Optional display value for timeout messages. The deadline always comes
    // from timeoutMs; when set, expiry reports this value instead, so a
    // re-wait running on a leftover budget still names the configured wait.
    timeoutLabelMs?: number;
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
    const labelMs = input.timeoutLabelMs ?? input.timeoutMs;
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
            ? `Target activity could not be determined (${activity.reason}) when the ${labelMs}ms wait ended (${count}). No text was sent.`
            : `Target activity could not be determined: no observation completed within the ${labelMs}ms wait. No text was sent.`,
          activity, waitedMs: input.timeoutMs, attempts,
        }
        : {
          ok: false as const,
          reason: "wait_for_idle_timeout",
          error: `Target was still busy (${activity.reason}) when the ${labelMs}ms wait ended (${count}). No text was sent.`,
          activity, waitedMs: input.timeoutMs, attempts,
        };
    };

    const cancelReason = input.cancelledBy === "caller" ? CALLER_CANCELLED : "preparation_cancelled";
    const cancelled = () => ({
      ok: false as const,
      reason: cancelReason,
      error: input.cancelledBy === "caller"
        ? "The request was cancelled while it waited for the seat to be idle. No text was sent, and none will be."
        : "Managed preparation ended; no compact authorized.",
      activity: last ?? {
        state: "unknown" as const, reason: cancelReason, evidenceSource: "pane_heuristic" as const,
        sampledAt: this.now().toISOString(), evidence: null,
      },
      waitedMs: Math.max(0, Math.min(input.timeoutMs, input.timeoutMs - (deadline - Date.now()))),
      attempts,
    });

    while (true) {
      if (input.signal?.aborted) return cancelled();
      if (attempts > 0 && Date.now() > deadline) return expire();
      attempts++;
      // A caller's cancellation also ends a pending observation (the abandoned read is ignored, never delivered on).
      // Managed preparation's wait keeps its own behaviour: it doesn't race the read against its signal.
      const activity = await this.observeReadinessWithin(input, deadline - Date.now(), input.cancelledBy === "caller" ? input.signal : undefined);
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
          error: `Target requires attention (${activity.reason}).${clearAttentionHint(input.sessionName, activity.reason)} No text was sent.`,
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

  /** One readiness observation, raced against the time left before the wait's deadline and, when given, the
   *  caller's cancellation. Null when the deadline or the cancellation wins; the abandoned observation is ignored,
   *  never delivered on. */
  private async observeReadinessWithin(
    input: { sessionName: string; runtime: string | null; attachmentType: string | null; binding?: ObservedBinding; readinessFromPaneOnly?: boolean; postCompactTurnBoundary?: boolean; privateInput?: boolean },
    remainingMs: number,
    cancel?: AbortSignal,
  ): Promise<AgentActivity | null> {
    if (cancel?.aborted) return null;
    const observation = this.classifySendReadiness(input, input.privateInput);
    observation.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        observation,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, remainingMs)); }),
        ...(cancel ? [new Promise<null>((resolve) => { onAbort = () => resolve(null); cancel.addEventListener("abort", onAbort, { once: true }); })] : []),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (cancel && onAbort) cancel.removeEventListener("abort", onAbort);
    }
  }

  private async claudeDeliveryObservation(sessionName: string, pane: string | null, resumeToken: string | null, rotation: ClaudeResumeRotation | null = null): Promise<ClaudeDeliveryObservation> {
    const unknown = { state: "unknown" as const, detail: "Claude runtime observation or older launch binding is unavailable" };
    try {
      const panes = await this.tmuxAdapter.listPanes(sessionName);
      if (!pane && panes.length > 1) {
        return { state: "conflict", detail: "The session has several panes but no recorded bound pane" };
      }
      if (panes.length > 0 && pane && !panes.some(candidate => candidate.id === pane)) {
        return { state: "conflict", detail: "The session does not have the expected bound pane" };
      }
      if (!pane || panes.length === 0) return unknown;
      let panePid: number | null;
      if (panes.length === 1) {
        const [sessionPid, observedPanePid] = await Promise.all([this.tmuxAdapter.getPanePid(sessionName), this.tmuxAdapter.getPanePid(pane)]);
        if (sessionPid && observedPanePid && sessionPid !== observedPanePid) return { state: "conflict", detail: "The session and bound pane name different processes" };
        panePid = observedPanePid;
      } else {
        // A session target resolves to its current pane, which may be a sibling
        // panel. With more than one pane, the immutable bound pane is the only
        // process identity that can be compared safely.
        panePid = await this.tmuxAdapter.getPanePid(pane);
      }
      const observation = await observeClaudeDelivery({ target: pane, tmux: this.tmuxAdapter, listProcesses: this.listProcesses, expectedToken: resumeToken, rotation });
      // Refusal already has positive evidence; a later failed read cannot erase it.
      if (observation.state === "conflict" || observation.state === "idle_shell") return observation;
      const after = await this.tmuxAdapter.listPanes(sessionName);
      if (after.length > 0 && !after.some(candidate => candidate.id === pane)) return { state: "conflict", detail: "The bound pane changed during delivery verification" };
      const currentPid = await this.tmuxAdapter.getPanePid(pane);
      if (panePid && currentPid && panePid !== currentPid) return { state: "conflict", detail: "The bound pane process changed during delivery verification" };
      return after.length === 0 || !panePid || !currentPid ? unknown : observation;
    } catch { return unknown; }
  }

  /** Shell label without positive native proof; not proof of an idle shell or stopped agent.
   * Null when no shell label is observed, or the expected native process is verified. */
  private async unverifiedShellForeground(sessionName: string, runtime: string, pane: string | null, resumeToken: string | null): Promise<string | null> {
    let paneCommand: string | null;
    const readTarget = pane ?? sessionName;
    try {
      paneCommand = await this.tmuxAdapter.getPaneCommand(readTarget);
    } catch {
      return null;
    }
    if (!paneCommand || !isShellForeground(paneCommand)) return null;
    if (runtime === "codex" && pane) {
      // Reuse stable, foreground, pane-descendant Codex proof. A resumed process
      // must name this session's token. Stale UI, a Node
      // launcher alone, missing observations or a native process elsewhere cannot clear it.
      const native = await verifyCodexPaneProcess({ target: readTarget, tmux: this.tmuxAdapter,
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
    readinessFromPaneOnly?: boolean;
    postCompactTurnBoundary?: boolean;
  }, privateInput = false): Promise<AgentActivity> {
    const now = this.now();
    let binding = input.binding;
    let communityHarness: string | null = null;
    try {
      const stored = this.getSessionMeta(input.sessionName);
      communityHarness = stored.communityHarness;
      binding = {
        sessionName: input.sessionName,
        nodeId: binding?.nodeId ?? stored.nodeId,
        occupant: binding?.occupant ?? stored.occupant,
        pane: binding?.pane ?? stored.pane,
      };
    } catch { /* An unavailable binding keeps the existing session-name fallback. */ }
    const composerSnapshot = this.tmuxAdapter.deliveryGuard?.needsInputCheck(input.sessionName)
      ? () => this.tmuxAdapter.captureComposerSnapshot(binding?.pane ?? input.sessionName) : undefined;
    const hookActivity = this.agentActivityStore?.getLatestForNode({
      sessionName: input.sessionName,
      now,
    });
    const permissionPending = latestHookPermissionPending(hookActivity, input.runtime);
    if (hookActivity && permissionPending && this.hookFreshForSend(hookActivity, now)) {
      return { ...hookActivity, state: "needs_input" };
    }
    // Pane-only readiness never lets a hook authorise a send, but a fresh hook showing work or a
    // waiting person still refuses one, as it does for every other send.
    if (
      input.readinessFromPaneOnly &&
      hookActivity &&
      hookActivity.evidenceSource === "runtime_hook" &&
      hookActivity.stale !== true &&
      this.hookFreshForSend(hookActivity, now) &&
      (hookActivity.state === "running" || hookActivity.state === "needs_input")
    ) {
      return hookActivity;
    }
    // Use the fresh runtime-hook as the authoritative signal ONLY within the tight send-readiness
    // window. Beyond it (but still inside the looser display freshness) the hook is too old to prove
    // "safe to send now" — fall through to the real-time capture-pane probe (also Codex's sole guard).
    if (
      !input.readinessFromPaneOnly &&
      hookActivity &&
      hookActivity.evidenceSource === "runtime_hook" &&
      hookActivity.stale !== true &&
      hookActivity.reason !== "permission_request_pending" &&
      hookActivity.reason !== "permission_prompt_cleared"
    ) {
      // Fresh hook (within the 15s send window): authoritative for any state.
      if (this.hookFreshForSend(hookActivity, now)) {
        if (hookActivity.state === "running" && input.runtime === "claude-code") {
          const paneVeto = await probeSessionActivity({
            communityHarness, communityHarnessSendProbe: true,
            composerSnapshot,
            currentClaudeDialogueOnly: true,
            sessionName: input.sessionName,
            runtime: input.runtime,
            attachmentType: input.attachmentType as "tmux" | "external_cli" | null | undefined,
            tmuxAdapter: this.tmuxAdapter,
            now,
            captureObserver: privateInput ? undefined : this.captureObserver,
            binding,
          });
          if (paneVeto.state === "needs_input") return paneVeto;
        }
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
          communityHarness, communityHarnessSendProbe: true,
          composerSnapshot,
          sessionName: input.sessionName,
          runtime: input.runtime,
          attachmentType: input.attachmentType as "tmux" | "external_cli" | null | undefined,
          tmuxAdapter: this.tmuxAdapter,
          now,
          captureObserver: privateInput ? undefined : this.captureObserver,
          binding,
        });
        if (paneVeto.state === "needs_input") {
          return paneVeto;
        }
        return hookActivity;
      }
    }

    const probe = await probeSessionActivity({
      communityHarness, communityHarnessSendProbe: true,
      composerSnapshot,
      sessionName: input.sessionName,
      runtime: input.runtime,
      attachmentType: input.attachmentType as "tmux" | "external_cli" | null | undefined,
      tmuxAdapter: this.tmuxAdapter,
      now,
      captureObserver: privateInput ? undefined : this.captureObserver,
      binding,
      // Pane-only readiness must not send into a status row whose timer hasn't appeared yet.
      timerlessStatusIsLive: input.readinessFromPaneOnly === true,
      postCompactTurnBoundary: input.postCompactTurnBoundary === true,
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
    if (probe.state === "unknown" && permissionPending) {
      return { ...probe, state: "needs_input", reason: "permission_request_unverified" };
    }
    // A latest hook saying the seat waits on a person (approval, picker or elicitation) stays positive
    // picker evidence past the send window, and past the store's freshness window: nothing newer was
    // recorded, so nothing answered it. The pane alone can miss a picker it has no signature for (a
    // Claude AskUserQuestion with option previews read unknown, and a watchdog wake's Enter chose its
    // first option). An UNKNOWN pane keeps the hook's verdict; a pane that reads work or a recognized
    // empty composer shows the seat has moved on.
    if (probe.state === "unknown" && hookActivity && latestHookWaitsOnPerson(hookActivity, input.runtime)) {
      return {
        ...hookActivity,
        state: "needs_input",
        reason: `${hookActivity.rawSubtype ?? hookActivity.rawEvent ?? "needs_input"}; ${LATEST_HOOK_ONLY}`,
      };
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
    const urlNames = ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT", "RIGGED_PORT"];
    const tokenNames = ["OPENRIG_ACTIVITY_HOOK_TOKEN", "RIGGED_ACTIVITY_HOOK_TOKEN"];
    const runtimeNames = ["OPENRIG_RUNTIME", "RIGGED_RUNTIME"];
    const inspected = typeof this.tmuxAdapter?.hasSessionEnvBatch === "function" || typeof this.tmuxAdapter?.hasSessionEnv === "function";
    if (typeof this.tmuxAdapter?.hasSessionEnvBatch === "function") {
      // One fresh listing for every name, read once per diagnosis: all aliases see the same moment. A failed listing
      // leaves every name unknown (never absent) and is not retried name by name.
      let presence: Record<string, boolean | null> = {};
      try {
        presence = await this.tmuxAdapter.hasSessionEnvBatch(sessionName, [...urlNames, ...tokenNames, ...runtimeNames]);
      } catch { /* every name stays unknown */ }
      const anyPresent = (names: string[]): boolean | null => {
        let unknown = false;
        for (const name of names) {
          const present = presence[name];
          if (present === true) return true;
          if (present !== false) unknown = true;
        }
        return unknown ? null : false;
      };
      hasUrl = anyPresent(urlNames);
      hasToken = anyPresent(tokenNames);
      hasRuntime = anyPresent(runtimeNames);
    } else if (typeof this.tmuxAdapter?.hasSessionEnv === "function") {
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
      hasUrl = await anyPresent(urlNames);
      hasToken = await anyPresent(tokenNames);
      hasRuntime = await anyPresent(runtimeNames);
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
    const unread = inspected ? prerequisites.filter((p) => p.present === null).map((p) => p.label) : [];
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

  // Record actor/reason with the actual readiness, never a fabricated prompt classification.
  // Report an unavailable sink to the caller: a positive-picker override still fails closed,
  // while other readiness states keep their existing accepted-send behavior with an advisory.
  private recordPromptOverride(input: {
    sessionName: string;
    readiness: AgentActivity;
    actorSession: string | null;
    overrideReason: string | null;
    input?: OverrideInputAudit;
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
        ...(input.input ? { input: input.input } : {}),
      });
      return { ok: true };
    } catch {
      return { ok: false, reason: "audit_persist_failed" };
    }
  }

  /** `inputBox`: also describe a Claude Code or Codex seat's live input box (three more tmux reads), for callers that
   *  use it: the capture route asks when its request does (`rig capture`, the MCP tool). `inputBoxBudget` is the time
   *  those reads may still take, shared across a fan-out; a single capture gets its own CAPTURE_INPUT_BOX_DEADLINE_MS. */
  async capture(sessionName: string, opts?: { lines?: number; inputBox?: boolean; inputBoxBudget?: InputBoxBudget; promptPane?: boolean;
    readable?: { width: number; height: number }; readableBudget?: ReadableBudget }): Promise<CaptureResult> {
    sessionName = physicalSessionName(this.db, sessionName);
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
      const target = this.absenceProbeTarget(sessionName);
      const observedAt = this.now().toISOString();
      const probe = await this.tmuxAdapter.probeSession(sessionName);
      if (probe.state === "absent") {
        this.recordSessionMissingVerdict(target, observedAt);
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
    const read = async (): Promise<CaptureResult> => {
      const content = await this.tmuxAdapter.capturePaneContent(sessionName, lines);
      if (content === null) {
        return {
          ok: false,
          sessionName,
          reason: "capture_failed",
          error: `Could not capture pane content for '${sessionName}'.`,
        };
      }

      await this.reconcileStartupReadiness(sessionName).catch(() => {});

      const runtime = sessionMeta.runtime;
      const inputBox = opts?.inputBox && (runtime === "claude-code" || runtime === "codex")
        ? await this.captureInputBox(sessionName, runtime, opts.inputBoxBudget ?? { remainingMs: CAPTURE_INPUT_BOX_DEADLINE_MS })
        : undefined;
      const promptPane = opts?.promptPane ? await this.capturePromptPane(sessionName, content, runtime) : undefined;
      return { ok: true, sessionName, content, lines, ...(inputBox ? { inputBox } : {}), ...(promptPane ? { promptPane } : {}) };
    };
    if (!opts?.readable) return read();
    const { value, readable } = await this.readAtReadableSize(sessionName, opts.readable,
      opts.readableBudget ?? { remainingMs: CAPTURE_READABLE_BUDGET_MS }, read);
    return value.ok ? { ...value, readable } : value;
  }

  /**
   * Run `read` with the seat's window enlarged to at least `size`, then put the window back: its size, and its own
   * `window-size` exactly. resize-window sets that to manual, which would stop the window's clients (Herdr, attach)
   * sizing it. The window is named by its id, and the resize is recorded as a pin (window-pin.ts) in the window's
   * queue, so a web terminal that opens meanwhile keeps the window's own value and the window is put back only when the
   * last live holder lets go. Read as it is, with the reason: a window already that big; one whose own `window-size`
   * is manual for a live holder or a person (a pin whose holders are gone is taken over and given back); one whose
   * sizing can't be read or whose record couldn't be written (it couldn't be given back); one with several panes; and
   * any seat once `budget` (shared across a fan-out) is spent.
   */
  private async readAtReadableSize<T>(sessionName: string, size: { width: number; height: number }, budget: ReadableBudget,
    read: () => Promise<T>): Promise<{ value: T; readable: NonNullable<CaptureResult["readable"]> }> {
    const started = this.now().getTime();
    const deadline = started + budget.remainingMs;
    const asItIs = async (reason: string) => ({ value: await read(), readable: { resized: false as const, reason } });
    const spent = `this capture's ${CAPTURE_READABLE_BUDGET_MS / 1000} s for readable reads ran out`;
    const late = () => deadline - this.now().getTime() < READABLE_MIN_REMAINING_MS;
    try {
      // Spent: no readable setup at all (no queue wait or sizing reads), so a long fan-out still returns in time.
      if (late()) return await asItIs(spent);
      const window = (await this.tmuxAdapter.readWindow(sessionName, WINDOW_SIZE_PRIOR_OPTION).catch(() => null))?.id;
      if (!window) return await asItIs("the window's sizing couldn't be read, so it couldn't be given back");
      const pin = await withWindowPin(window, async () => {
        const sizing = await readPinSizing(this.tmuxAdapter, window);
        if (!sizing) return "the window's sizing couldn't be read, so it couldn't be given back";
        if (sizing.live === "manual" && (sizing.prior === "manual" || sizing.holders.length > 0)) {
          return "the window's size is pinned (its window-size is manual)";
        }
        // Still manual here: a pin whose holders are gone (a capture or a web terminal that ended without giving it back).
        // It's taken over, and given back after this read even when the pane is already big enough.
        const leftover = sizing.live === "manual";
        const panes = await this.tmuxAdapter.listPanes(window).catch(() => []);
        if (panes.length !== 1) return panes.length === 0 ? "the window's size couldn't be read" : "the window has several panes";
        const pane = panes[0]!;
        const bigEnough = pane.width >= size.width && pane.height >= size.height;
        if (bigEnough && !leftover) return `the pane is already ${pane.width}x${pane.height}`;
        if (!bigEnough && late()) return spent;
        const holder = newPinHolder();
        if (!(await recordPin(this.tmuxAdapter, sizing, holder))) return "its restore record couldn't be written, so it wasn't resized";
        // The record can settle late: past the deadline, let go without resizing.
        if (!bigEnough && late()) return { holder, pane, resized: null, spent: true };
        const resized = bigEnough ? null
          : await this.tmuxAdapter.resizeWindow(window, Math.max(size.width, pane.width), Math.max(size.height, pane.height));
        return { holder, pane, resized, spent: false };
      });
      if (typeof pin === "string") return await asItIs(pin);
      const { holder, pane, resized } = pin;
      if (pin.spent) {
        await releasePin(this.tmuxAdapter, window, holder);
        return await asItIs(spent);
      }
      let readable: NonNullable<CaptureResult["readable"]> | undefined;
      let value: T;
      try {
        if (!resized) {
          readable = { resized: false, reason: `the pane is already ${pane.width}x${pane.height}` };
          value = await read();
        } else if (!resized.ok) {
          readable = { resized: false, reason: `the resize failed: ${resized.message}` };
          value = await read();
        } else {
          await this.settleRedraw(sessionName, deadline);
          value = await read();
          readable = { resized: true, width: Math.max(size.width, pane.width), height: Math.max(size.height, pane.height), release: "not-listed" };
        }
      } finally {
        // As the last holder: back to its size first (that pins it again), then its own sizing, so a window with
        // clients follows them again.
        let sizeBack: TmuxResult | null = null;
        const release = await releasePin(this.tmuxAdapter, window, holder, resized ? async () => {
          sizeBack = await this.tmuxAdapter.resizeWindow(window, pane.width, pane.height);
        } : undefined);
        if (readable?.resized) {
          readable.release = release;
          const back = sizeBack as TmuxResult | null;
          if (back && !back.ok) readable.sizeBack = `putting its size back failed: ${back.message}`;
        }
        else if (!resized && release === "given-back" && readable) readable.reason += "; a pin left on its window was given back";
      }
      return { value, readable: readable! };
    } finally {
      budget.remainingMs = Math.max(0, budget.remainingMs - (this.now().getTime() - started));
    }
  }

  /** After a resize, give the seat's TUI time to redraw: two equal screens 150 ms apart, at most 12 looks, and never
   *  past `deadline`. */
  private async settleRedraw(sessionName: string, deadline: number): Promise<void> {
    let last: string | null = null;
    for (let look = 0; look < 12 && this.now().getTime() + 150 <= deadline; look++) {
      await this.sleep(150);
      const screen = await this.tmuxAdapter.capturePaneScreen(sessionName).catch(() => null);
      if (screen !== null && screen === last) return;
      last = screen;
    }
  }

  /** A prompt drawn in a pane smaller than an 80x24 terminal may be cut off, so a reader can't see what the seat asks.
   *  The pane size is read only when the captured screen shows a prompt. */
  private async capturePromptPane(sessionName: string, content: string, runtime: string | null | undefined): Promise<CaptureResult["promptPane"]> {
    const prompt = classifyPaneActivity(content, { runtime });
    if (prompt.reason !== "permission_prompt" && prompt.reason !== "selection_prompt") return undefined;
    const panes = await this.tmuxAdapter.listPanes(sessionName).catch(() => []);
    const pane = panes.find(entry => entry.active) ?? panes[0];
    if (!pane || (pane.width >= 80 && pane.height >= 24)) return undefined;
    return { width: pane.width, height: pane.height,
      hint: `pane ${pane.width}x${pane.height} is smaller than 80x24, so the prompt may be cut off; read it at a readable size with rig capture ${sessionName} --readable` };
  }

  /** The input box, or unknown when its reads don't finish within the budget's remaining time (or none is left): the
   *  pane text is already in hand, so a slow read never holds the capture. The time spent comes off the budget. A read
   *  still pending then settles on its own, unused. */
  private async captureInputBox(sessionName: string, runtime: "claude-code" | "codex", budget: InputBoxBudget): Promise<InputBoxAnnotation> {
    if (budget.remainingMs <= 0) return annotateInputBox(null, null, runtime, { budgetSpent: true });
    const started = this.now().getTime();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<InputBoxAnnotation>((resolve) => {
      timer = setTimeout(() => resolve(annotateInputBox(null, null, runtime, { timedOut: true })), budget.remainingMs);
    });
    try {
      return await Promise.race([this.readInputBoxAnnotation(sessionName, runtime), late]);
    } finally {
      clearTimeout(timer);
      budget.remainingMs -= this.now().getTime() - started;
    }
  }

  /** One styled read of the visible screen with the cursor read before and after it: a cursor that moved, or a pane
   *  that resized, in between is reported as moved; when only one read succeeds, its reading is passed on as seen once.
   *  Never throws. */
  private async readInputBoxAnnotation(sessionName: string, runtime: "claude-code" | "codex"): Promise<InputBoxAnnotation> {
    try {
      const before = await this.tmuxAdapter.getPaneCursorPosition(sessionName);
      const screen = await this.tmuxAdapter.capturePaneContent(sessionName, 0, { escapeSequences: true });
      const after = await this.tmuxAdapter.getPaneCursorPosition(sessionName);
      const steady = before && after && before.x === after.x && before.y === after.y
        && before.width === after.width && before.height === after.height ? after : null;
      const cursorSeenOnce = (before === null) !== (after === null) ? before ?? after : null;
      return annotateInputBox(screen, steady, runtime, { cursorMoved: before !== null && after !== null && steady === null, cursorSeenOnce });
    } catch {
      return annotateInputBox(null, null, runtime);
    }
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
        exactText: opts?.envelopeSender ? text : undefined,
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

  private getReconciliationSnapshot(sessionName: string): SessionReconciliationSnapshot | undefined {
    return this.db.prepare(`
      SELECT n.id as node_id, r.id as rig_id, s.id as session_id, s.session_name, n.runtime, n.cwd,
             s.startup_status, s.status as session_status, s.startup_completed_at,
             s.resume_type, s.resume_token, s.resume_provenance, s.resume_rotated_from, s.resume_rotated_process, s.resume_launch_process,
             b.tmux_session as binding_session, b.tmux_window as binding_window, b.tmux_pane as binding_pane,
             b.updated_at as binding_updated_at,
             (SELECT generation_uuid FROM occupant_tenures WHERE node_id = n.id ORDER BY generation_ordinal DESC LIMIT 1) as occupant_generation,
             (SELECT id FROM sessions WHERE node_id = n.id ORDER BY id DESC LIMIT 1) as latest_session_id,
             (SELECT MAX(seq) FROM events e WHERE e.node_id = n.id AND e.type IN ('node.startup_pending', 'node.startup_ready', 'node.startup_failed')) as startup_event_seq
      FROM sessions s
      JOIN nodes n ON n.id = s.node_id
      JOIN rigs r ON r.id = n.rig_id
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE s.session_name = ?
      ORDER BY s.id DESC LIMIT 1
    `).get(sessionName) as SessionReconciliationSnapshot | undefined;
  }

  /**
   * Reconcile non-ready startup state after successful session interaction (Refs #7).
   *
   * If an active session is in a non-ready startup state (`failed` or `attention_required`),
   * re-check readiness via the runtime adapter with currentness verification and atomic commit.
   */
  async reconcileStartupReadiness(sessionName: string): Promise<boolean> {
    sessionName = physicalSessionName(this.db, sessionName);
    const existing = this.inFlightReconciliations.get(sessionName);
    if (existing) return existing;

    const promise = this.doReconcileStartupReadiness(sessionName);
    this.inFlightReconciliations.set(sessionName, promise);
    try {
      return await promise;
    } finally {
      this.inFlightReconciliations.delete(sessionName);
    }
  }

  private async doReconcileStartupReadiness(sessionName: string): Promise<boolean> {
    const snapshot = this.getReconciliationSnapshot(sessionName);
    if (!snapshot) return false;
    if (snapshot.startup_status !== "failed" && snapshot.startup_status !== "attention_required") return false;
    if (snapshot.session_status !== "running") return false;
    if (snapshot.session_id !== snapshot.latest_session_id) return false;
    if (!isRecoverableStartupFailure(this.db, snapshot.node_id, snapshot.session_id)) return false;

    const checker = this.runtimeAdapters[snapshot.runtime];
    if (!checker?.checkReady) return false;

    const hasClaudeIdentityWork = (
      nodeId: string,
      sessionId: string,
      runtime: string,
    ): boolean => {
      if (runtime !== "claude-code") return false;
      const failedEvent = getLatestStartupFailedEvent(this.db, nodeId, sessionId);
      if (!failedEvent || failedEvent.requestedResumeToken === undefined || failedEvent.requestedResumeType === undefined) {
        return true;
      }
      return hasClaudeResumeIdentityWork(
        this.sessionRegistry,
        sessionId,
        runtime,
        failedEvent.requestedResumeToken,
        failedEvent.requestedResumeType,
      );
    };

    // A Claude seat is checked with its real pane, occupant and recorded conversation (#1477); others keep the stand-in.
    const claude = snapshot.runtime === "claude-code";
    const rotation = claude ? claudeResumeRotation(snapshot) : null;
    const probeBinding: NodeBinding = {
      id: `session-transport:${snapshot.session_id}`,
      nodeId: snapshot.node_id,
      attachmentType: "tmux",
      tmuxSession: sessionName,
      tmuxWindow: null,
      tmuxPane: claude ? snapshot.binding_pane : null,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: "",
      cwd: snapshot.cwd ?? "",
      ...(claude && snapshot.occupant_generation ? { launchGeneration: snapshot.occupant_generation } : {}),
    };

    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<ReadinessResult>((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error("readiness probe timeout")), 5000);
    });

    let readiness: ReadinessResult;
    try {
      readiness = await Promise.race([checker.checkReady(probeBinding, ...(claude && snapshot.resume_token ? [{ resumeToken: snapshot.resume_token, ...(rotation ? { resumeRotation: rotation } : {}) }] : [])), timeoutPromise]);
    } catch {
      return false;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    let emittedReady = false;

    this.db.transaction(() => {
      const current = this.getReconciliationSnapshot(sessionName);
      if (!current || JSON.stringify(current) !== JSON.stringify(snapshot)) return;
      if (!isRecoverableStartupFailure(this.db, snapshot.node_id, snapshot.session_id)) return;

      const currentIdentityWork = hasClaudeIdentityWork(
        current.node_id,
        current.session_id,
        current.runtime,
      );

      if (readiness.ready) {
        if (currentIdentityWork) {
          this.db.prepare(`
            UPDATE sessions
            SET startup_status = 'attention_required'
            WHERE id = ? AND startup_status = 'failed'
          `).run(snapshot.session_id);
          return;
        }

        const result = this.db.prepare(`
          UPDATE sessions
          SET startup_status = 'ready',
              startup_completed_at = ?
          WHERE id = ? AND startup_status IN ('failed', 'attention_required')
        `).run(new Date().toISOString(), snapshot.session_id);

        if (result.changes > 0) {
          emittedReady = true;
        }
        return;
      }

      if (isAttentionRequiredReadinessCode(readiness.code)) {
        this.db.prepare(`
          UPDATE sessions
          SET startup_status = 'attention_required'
          WHERE id = ? AND startup_status = 'failed'
        `).run(snapshot.session_id);
      }
    }).immediate();

    if (emittedReady && this.eventBus) {
      this.eventBus.emit({
        type: "node.startup_ready",
        rigId: snapshot.rig_id,
        nodeId: snapshot.node_id,
        previousStatus: snapshot.startup_status as "failed" | "attention_required",
      });
      return true;
    }

    return false;
  }
}

/** A region of the visible screen: zero-based rows and columns as tmux reports the cursor, end column exclusive. */
export interface InputBoxSpan {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** The region's text, one line per screen row (a soft-wrapped line spans rows). */
  text: string;
}

/**
 * What a capture says about a Claude Code or Codex seat's live input box: its text, where it is, and which part is
 * likely a harness suggestion (ghost text) rather than something the person typed. Read from one styled capture of
 * the visible screen and the cursor, never from scrollback or the terminal output above the box. A heuristic: a
 * person can move the cursor, text wraps, and harness versions differ, so conflicting or missing evidence reads
 * `unknown` rather than a guess.
 */
export interface InputBoxAnnotation {
  status: "empty" | "typed" | "likely-suggestion" | "typed-with-suggestion" | "unknown" | "no-input-box";
  confidence: "high" | "medium" | "low" | "unknown";
  /** tmux's cursor on the visible screen (zero-based), or null when it couldn't be read or moved during the read. */
  cursor: { x: number; y: number; width: number; height: number } | null;
  /** All the text in the input box. */
  input: InputBoxSpan | null;
  /** The part of `input` that is likely a harness suggestion. */
  suggestion: InputBoxSpan | null;
  evidence: string[];
  /** One sentence for the reader: what the box holds and how much to trust it. */
  hint: string;
}

const INPUT_CONTINUATION_COLUMN = 2; // Claude Code and Codex indent an input's later rows by two cells
// How long a capture's input-box reads may take in all before the box reports unknown: one seat's three reads, or a
// whole fan-out's (the send path's INPUT_BOX_READ_DEADLINE_MS bounds one read each).
export const CAPTURE_INPUT_BOX_DEADLINE_MS = 1_000;

/** The time a capture's readable reads (`--readable`, `--size`) may take: the resize, the redraw and the read, for one
 *  seat or a whole fan-out. Seats left once it's spent are read as they are, so the request returns inside the CLI's
 *  wait (capture.ts's READABLE_REQUEST_TIMEOUT_MS). Each window is given back whatever is left. */
export const CAPTURE_READABLE_BUDGET_MS = 8_000;
/** Below this, a seat isn't resized: two redraw looks and the read wouldn't fit. */
const READABLE_MIN_REMAINING_MS = 500;

/** The time a capture's readable reads may still take; the capture route shares one across a fan-out. */
export interface ReadableBudget {
  remainingMs: number;
}

/** The time a capture's input-box reads may still take; the capture route shares one across a fan-out. */
export interface InputBoxBudget {
  remainingMs: number;
}
// Claude Code's input frame rule, as findClaudeComposer and the composer-boundary reader match it (a label may sit in it).
const CLAUDE_FRAME_RULE = /^─{3,}(?: .+ ─+)?$/;

/** The input box's rows on the screen: Claude Code's prompt row inside its frame (the opening rule directly above it,
 *  through the row before the closing rule), or Codex's box as codexInputBox reads it. A committed prompt row in the
 *  transcript, or a prompt-looking line in output, has no opening rule above it. Null when no input box is recognized
 *  (a selector, a menu instead of a box, busy output with no box, another layout). */
function inputBoxRows(lines: string[], runtime: "claude-code" | "codex"): { first: number; last: number; empty?: boolean } | null {
  if (runtime === "codex") {
    const box = codexInputBox(lines.join("\n"));
    if (!box) return null;
    return { first: box.inputAt, last: box.inputAt + Math.max(box.rows.length, 1) - 1, empty: box.text === "" };
  }
  const promptClass = composerPromptClassForRuntime("claude-code");
  const first = findComposerInputLineIndex(lines, promptClass);
  if (first < 1 || composerNumberedChoicePattern(promptClass).test(lines[first]!.trimStart())) return null;
  // A rule at the prompt's own indent: an input's later rows are indented, so a rule typed inside it never closes it.
  const indent = /^[ \t]*/.exec(lines[first]!)![0];
  const frame = (line: string) => line.startsWith(indent) && CLAUDE_FRAME_RULE.test(line.slice(indent.length).trimEnd());
  if (!frame(lines[first - 1]!)) return null;
  let close = first + 1;
  while (close < lines.length && !frame(lines[close]!)) close++;
  return close < lines.length ? { first, last: close - 1 } : null;
}

export function annotateInputBox(
  styledScreen: string | null,
  cursor: { x: number; y: number; width: number; height: number } | null,
  runtime: "claude-code" | "codex",
  opts: {
    cursorMoved?: boolean;
    timedOut?: boolean;
    budgetSpent?: boolean;
    /** The cursor as the one successful read of two saw it; it can show the cursor outside the box, never confirm it in. */
    cursorSeenOnce?: { x: number; y: number } | null;
  } = {},
): InputBoxAnnotation {
  const harness = runtime === "codex" ? "Codex" : "Claude Code";
  const result = (status: InputBoxAnnotation["status"], confidence: InputBoxAnnotation["confidence"], hint: string,
    input: InputBoxSpan | null = null, suggestion: InputBoxSpan | null = null, evidence: string[] = []): InputBoxAnnotation =>
    ({ status, confidence, cursor, input, suggestion, evidence, hint });
  const budget = `${CAPTURE_INPUT_BOX_DEADLINE_MS / 1000} s`;
  if (opts.timedOut) {
    return result("unknown", "unknown", `The input box's reads didn't finish within this capture's ${budget} budget, so it wasn't checked.`,
      null, null, ["input box reads timed out"]);
  }
  if (opts.budgetSpent) {
    return result("unknown", "unknown", `The input box wasn't read: this capture's ${budget} budget for input-box reads was spent on earlier seats.`,
      null, null, ["input box budget spent"]);
  }
  if (!styledScreen?.trim()) return result("unknown", "unknown", "The screen couldn't be read, so the input box wasn't checked.");
  const cells = styledLines(styledScreen);
  const lines = cells.map((row) => row.map((cell) => cell.ch).join(""));
  const box = inputBoxRows(lines, runtime);
  if (!box) return result("no-input-box", "unknown", `No ${harness} input box was recognized on the screen.`);

  // Each box row's text cells with their screen columns. The first row's text starts after the prompt glyph and its
  // space, a later row's after its two-cell indent.
  const rows: Array<{ row: number; cells: Array<{ ch: string; faint: boolean; col: number }> }> = [];
  for (let row = box.first; row <= box.last; row++) {
    let col = 0;
    const placed = (cells[row] ?? []).map((cell) => { const at = col; col += stringWidth(cell.ch); return { ...cell, col: at }; });
    const glyphAt = row === box.first ? placed.findIndex((cell) => cell.ch === "❯" || cell.ch === "›") : -1;
    const startCol = row === box.first ? (glyphAt >= 0 ? placed[glyphAt]!.col + 2 : INPUT_CONTINUATION_COLUMN) : INPUT_CONTINUATION_COLUMN;
    let text = placed.filter((cell) => cell.col >= startCol);
    while (text.length && !text[text.length - 1]!.ch.trim()) text = text.slice(0, -1);
    rows.push({ row, cells: text });
  }
  const startCol = rows[0]!.cells[0]?.col ?? (lines[box.first]!.search(/[❯›]/) + 2);
  const spanOf = (from: { row: number; col: number }, to: { row: number; col: number }): InputBoxSpan => ({
    startRow: from.row, startCol: from.col, endRow: to.row, endCol: to.col,
    text: rows.filter((r) => r.row >= from.row && r.row <= to.row)
      .map((r) => r.cells.filter((cell) => (r.row > from.row || cell.col >= from.col) && (r.row < to.row || cell.col < to.col)).map((cell) => cell.ch).join(""))
      .join("\n"),
  });
  const textRows = rows.filter((r) => r.cells.length > 0);
  const outsideBox = (at: { y: number }) => at.y < box.first || at.y > box.last;
  // A cursor seen outside the box by the one read that worked still contradicts the box being the live one.
  const seenOutside = cursor === null && !opts.cursorMoved && opts.cursorSeenOnce != null && outsideBox(opts.cursorSeenOnce);
  const seenOutsideEvidence = "cursor outside the input box (the other cursor read failed)";
  if (box.empty || textRows.length === 0) {
    // Only a steady cursor in the box shows it's the live one: an empty frame drawn in output has the cursor below it, a
    // moved cursor means the box may have changed, and a missing cursor shows nothing either way.
    if (cursor !== null && !outsideBox(cursor)) return result("empty", "high", "The input box is empty.", null, null, ["no text in the input box"]);
    if (cursor !== null || seenOutside) {
      return result("unknown", "unknown", `An empty ${harness} input box was recognized, but the cursor is outside it, so it may not be the live box.`,
        null, null, ["no text in the input box", cursor !== null ? "cursor outside the input box" : seenOutsideEvidence]);
    }
    if (opts.cursorMoved) {
      return result("unknown", "unknown", `The ${harness} input box read empty, but the cursor moved during the capture, so it may have changed.`,
        null, null, ["no text in the input box", "cursor moved during the capture"]);
    }
    return result("unknown", "unknown", `An empty ${harness} input box was recognized, but the cursor couldn't be read, so it may not be the live box.`,
      null, null, ["no text in the input box", "cursor unavailable"]);
  }
  const lastRow = textRows[textRows.length - 1]!;
  const lastCell = lastRow.cells[lastRow.cells.length - 1]!;
  const end = { row: lastRow.row, col: lastCell.col + stringWidth(lastCell.ch) };
  const input = spanOf({ row: box.first, col: startCol }, end);
  const quote = (text: string) => {
    const flat = text.replace(/\s*\n\s*/g, " ").trim();
    return `"${flat.length > 60 ? `${flat.slice(0, 57)}...` : flat}"`;
  };

  const styled = /\x1b\[/.test(styledScreen);
  const textCells = rows.flatMap((r) => r.cells.filter((cell) => cell.ch.trim()).map((cell) => ({ ...cell, row: r.row })));
  const allFaint = styled && textCells.every((cell) => cell.faint);
  const noneFaint = styled && textCells.every((cell) => !cell.faint);
  // Claude Code's `Try "…"` words are a person's possible words too, so they count only where there's no styling to go
  // on, and at most as a possible (medium) suggestion. With styling, the faint text decides.
  const tryShape = runtime === "claude-code" && CLAUDE_TRY_SUGGESTION.test(input.text.replace(/\s+/g, ""));
  const trySuggestion = tryShape && !styled;
  const evidence: string[] = [];
  if (tryShape) evidence.push("Claude Code's Try \"...\" words");
  evidence.push(!styled ? "no styling in the capture" : allFaint ? "text drawn faint" : noneFaint ? "text not faint" : "part of the text drawn faint");

  const inBox = cursor !== null && cursor.y >= box.first && cursor.y <= box.last;
  const atStart = inBox && cursor!.y === box.first && cursor!.x === startCol;
  const atEnd = inBox && cursor!.y === end.row && cursor!.x === end.col;
  if (cursor === null) evidence.unshift(opts.cursorMoved ? "cursor moved during the capture" : seenOutside ? seenOutsideEvidence : "cursor unavailable");
  else evidence.unshift(!inBox ? "cursor outside the input box" : atStart ? "cursor at the input's start" : atEnd ? "cursor after the text" : "cursor inside the text");
  const why = evidence.join("; ");

  const likelySuggestion = (confidence: "high" | "medium") => result("likely-suggestion", confidence, confidence === "high"
    ? `The input box shows ${quote(input.text)}, likely a ${harness} suggestion (${why}), not something the person typed: it isn't their intent, a draft or a staged command.`
    : `The input box shows ${quote(input.text)}, possibly a ${harness} suggestion (${why}; medium confidence): don't take it as the person's intent, and don't assume it isn't their draft.`,
    input, input, evidence);
  const typed = (confidence: InputBoxAnnotation["confidence"]) => result("typed", confidence,
    `The input box holds ${quote(input.text)}, likely typed by the person and not yet sent (${why}).`, input, null, evidence);
  const unknown = () => result("unknown", "unknown",
    `The input box shows ${quote(input.text)}; whether the person typed it or it's a ${harness} suggestion is unknown (${why}).`, input, null, evidence);

  // A moved cursor or one seen outside the box contradicts any reading; only an unavailable cursor leaves the styling or
  // the Try words to go on, at medium confidence.
  if (cursor === null || !inBox) {
    if (cursor === null && !opts.cursorMoved && !seenOutside && (allFaint || trySuggestion)) return likelySuggestion("medium");
    return unknown();
  }
  if (atStart) {
    if (allFaint) return likelySuggestion("high");
    if (!styled) return likelySuggestion("medium");
    // Claude Code draws its suggestion faint (Codex draws its placeholder faint too); unfaint text with the cursor at its
    // start may be a draft the person moved the cursor back through, in either harness.
    return unknown();
  }
  if (atEnd) {
    if (noneFaint) return typed("high");
    if (!styled) return typed("medium");
    return unknown();
  }
  // The cursor is inside the text: the person moved it, or typed a prefix and the harness suggests the rest after it.
  const split = textCells.findIndex((cell) => cell.row > cursor.y || (cell.row === cursor.y && cell.col >= cursor.x));
  const before = split < 0 ? textCells : textCells.slice(0, split);
  const after = split < 0 ? [] : textCells.slice(split);
  if (styled && before.length > 0 && after.length > 0 && before.every((cell) => !cell.faint) && after.every((cell) => cell.faint)) {
    const suggestion = spanOf({ row: cursor.y, col: cursor.x }, end);
    const typedPart = spanOf({ row: box.first, col: startCol }, { row: cursor.y, col: cursor.x });
    return result("typed-with-suggestion", "high",
      `The input box holds ${quote(typedPart.text)}, likely typed by the person, then ${quote(suggestion.text)}, likely a ${harness} suggestion after the cursor (${why}; the text after the cursor is faint): the suggestion isn't their intent.`,
      input, suggestion, [...evidence, "the text after the cursor is faint"]);
  }
  if (noneFaint) return typed("medium");
  return unknown();
}
