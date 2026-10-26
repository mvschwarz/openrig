import {
  composerPromptClassForRuntime,
  composerPromptIsAmbiguous,
  composerSelectionPrefixPattern,
  findComposerInputLineIndex,
} from "./composer-prompts.js";

const normalize = (text: string): string => text.replace(/\s+/g, "");
// Claude 2.1.289 briefly replaces its mode bar after a bracketed paste.
// The hint is the bare line or carries an effort suffix, which depends on the seat's effort setting.
// Vim mode puts `-- INSERT --` ahead of either footer, and a narrow pane truncates the mode bar's hint,
// so a mode-bar line is also known by its leading marker.
const VIM_MODE_PREFIX = /^-- INSERT --\s*/;
const MODE_BAR_START = /^(?:⏵⏵|⏸)(?:\s|$)/;
// The suffix is a circle glyph and an effort level, e.g. `◐ medium` or `● high`; arbitrary text is not one.
const PASTE_HINT = /^paste again to expand(?:\s{2,}[◐●○◑◒◓] (?:low|medium|high|xhigh|max) · \/effort)?$/;
export const isClaudePasteHint = (line: string): boolean => PASTE_HINT.test(line.replace(VIM_MODE_PREFIX, ""));
export const isComposerFooter = (line: string): boolean => {
  const bar = line.replace(VIM_MODE_PREFIX, "");
  return (bar === "" && line !== "") || /(?:shift\+tab to cycle|\? for shortcuts)/i.test(bar) || MODE_BAR_START.test(bar)
    || PASTE_HINT.test(bar);
};
// This placeholder occupies an empty composer while submitted text is queued.
export const QUEUED_PLACEHOLDER = normalize("Press up to edit queued messages");

/** The same composer region used by the startup Enter guard. No transcript fallback. */
export function composerRegion(pane: string | null, runtime: string | null = null) {
  const promptClass = composerPromptClassForRuntime(runtime);
  const lines = (pane ?? "").split("\n");
  const inputAt = findComposerInputLineIndex(lines, promptClass);
  let end = -1;
  if (inputAt >= 0) {
    // Prompt text can itself contain rules (the startup challenge does), and a rule in the prompt can be followed by a
    // line that looks like a mode bar. The composer's closing rule is the last rule on the screen: only the footer
    // lines come after it. An unrecognized footer under it leaves the region unverified rather than falling back to
    // a rule inside the prompt.
    for (let i = lines.length - 1; i > inputAt; i--) {
      if (!/^[─═-]{10,}$/.test(lines[i]!.trim())) continue;
      if (isComposerFooter((lines.slice(i + 1).find((next) => next.trim()) ?? "").trim())) end = i;
      break;
    }
  }
  const body = inputAt < 0 || end < 0 || composerPromptIsAmbiguous(lines, inputAt, promptClass)
    || composerSelectionPrefixPattern(promptClass).test(lines[inputAt]!.trimStart())
    ? null : normalize(lines.slice(inputAt, end).join("\n").trimStart().slice(1));
  return { body, markerLine: inputAt < 0 ? null : inputAt + 1,
    closingRuleLine: end < 0 ? null : end + 1, capturedLines: pane === null ? 0 : lines.length };
}

/** Whether Claude's input box is drawn: its input line, then a closing rule with the composer footer under it. */
export function claudeInputBoxDrawn(pane: string | null): boolean {
  const { markerLine, closingRuleLine } = composerRegion(pane, "claude-code");
  return markerLine !== null && closingRuleLine !== null;
}

/** Whether a screen has no input line at all, as while Claude is still drawing it: not a draft and not a dialog. */
export function startupNoInputLine(pane: string | null, runtime: string | null = null): boolean {
  return Boolean(pane?.trim()) && composerRegion(pane, runtime).markerLine === null;
}

/** An echoed turn or a partial/opaque composer stays unverified. */
export function inspectStartupStagedText(pane: string | null, expected: string, runtime: string | null = null): "staged" | "clear" | "unverified" {
  const { body } = composerRegion(pane, runtime);
  if (body === null) return "unverified";
  if (!body) return "clear";
  if (body === normalize(expected)) return "staged";
  return body === QUEUED_PLACEHOLDER ? "clear" : "unverified";
}

// Claude 2.1.289 shows a long bracketed paste as this label until it is submitted; +M is the number of
// newlines in the pasted text (8 of 8 pastes in retained native runs). Matched on the normalized body.
export const COLLAPSED_PASTE = /^\[Pastedtext#\d+\+(\d+)lines\]$/;

/** Whether the composer holds only Claude's collapsed label for a paste with the expected text's newline count. */
export function startupOwnCollapsedPaste(pane: string | null, expected: string, runtime: string | null = null): boolean {
  const { body } = composerRegion(pane, runtime);
  const label = body === null ? null : COLLAPSED_PASTE.exec(body);
  return label !== null && Number(label[1]) === expected.split("\n").length - 1;
}

// A fresh Claude's first input, as startup sends it; a runtime switch's handover to a Claude successor uses the same rules.
// Expanded startup text can put the current input marker above 50 scrollback lines.
export const STARTUP_SUBMIT_CAPTURE_LINES = 200;
// Claude Code 2.1.289 has taken Enter on a large startup paste after the first look, while the composer
// still showed that paste collapsed. Only that transient is looked at again, 200 ms apart, up to this many
// times: about 5 s of waiting per send, plus capture time. Nothing is typed meanwhile.
export const STARTUP_SUBMIT_SETTLE_LOOKS = 25;
// A prompt still staged after a guarded retry is retried again, up to this many retries in all, each after
// the 200 ms look. Every retry is guarded: Enter goes in only while the composer holds exactly the text we typed.
export const STARTUP_SUBMIT_RETRIES = 2;

type ReadPane = () => Promise<string | null>;
type Sleep = (ms: number) => Promise<void>;

/**
 * A fresh launch can read ready before Claude has drawn its input box: on Linux the pane names `claude` the moment
 * Claude starts, and startup text pasted then sat unsent. Before a fresh start's first send, look at the visible
 * screen until the input box the startup check reads is drawn, at most STARTUP_SUBMIT_SETTLE_LOOKS looks 200 ms
 * apart. A screen that never shows one within that, or can't be read, is sent to as before. Observation only.
 */
export async function waitForClaudeInputBox(readScreen: ReadPane, sleep: Sleep): Promise<void> {
  for (let look = 0; look < STARTUP_SUBMIT_SETTLE_LOOKS; look++) {
    let screen: string | null;
    try { screen = await readScreen(); } catch { return; }
    if (screen === null || claudeInputBoxDrawn(screen)) return;
    await sleep(200);
  }
}

/**
 * Claude can take the startup Enter after the first look while the composer still shows our paste collapsed, and a
 * fresh Claude can still be drawing its screen, with no input line at all, when the first look comes. Only those
 * two transients are looked at again, until the composer reads clear or staged, shows anything else, or the looks
 * run out. A draft, ghost text, a dialog or any other mismatch keeps its verdict. Observation only.
 * Remaining ambiguity: a person who clears a collapsed paste with the same line count inside the window reads
 * as submitted.
 */
export async function settleOwnStartupPaste(read: ReadPane, pane: string, text: string, runtime: string | null, sleep: Sleep): Promise<{
  pane: string; state: ReturnType<typeof inspectStartupStagedText>; looks: number;
}> {
  let state = inspectStartupStagedText(pane, text, runtime);
  let looks = 0;
  while (state === "unverified" && looks < STARTUP_SUBMIT_SETTLE_LOOKS
    && (startupOwnCollapsedPaste(pane, text, runtime) || startupNoInputLine(pane, runtime))) {
    await sleep(200);
    // A failed re-look adds nothing; the last usable observation stands.
    const next = await read().catch(() => null);
    if (!next?.trim()) break;
    pane = next;
    state = inspectStartupStagedText(pane, text, runtime);
    looks++;
  }
  return { pane, state, looks };
}

export interface StartupSubmissionEvidence {
  /** One-based positions in this capture, not absolute terminal rows. */
  markerLine: number | null;
  closingRuleLine: number | null;
  capturedLines: number;
  captureScrollbackLines: number;
  /** Diagnostic only; absent for unavailable captures or an excluded selector. */
  reason?: "unrecognized_composer_boundary" | "extracted_text_mismatch";
  windowsOmitted: "unclassified-startup-text";
}

export interface StartupSubmissionDiagnostic {
  startupAttemptId: string;
  /** One-based order among this orchestrator's interactive sends. */
  sendOrder: number;
  source: "initial_identity" | "restore_preload" | "post_launch_file" | "challenge" | "startup_proof_instruction" | "after_files" | "after_ready";
  /** Zero-based index in the authored action list, when applicable. */
  actionIndex?: number;
  /** `look` is set only when our collapsed paste was looked at again: 0 for the first look, n for the last. */
  observations: Array<StartupSubmissionEvidence & { phase: "initial" | "guarded_retry" | "after_retry"; look?: number }>;
  /** Transport result only; ok does not assert model consumption. */
  retry: "not_run" | "ok" | "refused_or_failed" | "threw";
}

/** No excerpts: every startup source accepts arbitrary, potentially credential-bearing text.
 * Fixed-size metadata per capture (at most three per send), never a pane/prompt dump.
 * Diagnostics must not turn a delivery decision into a failure. */
export function startupSubmissionEvidence(pane: string | null, expected: string, captureScrollbackLines: number, runtime: string | null = null): StartupSubmissionEvidence | undefined {
  try {
    const { body, ...positions } = composerRegion(pane, runtime);
    const reason = !pane?.trim() ? undefined
      : positions.markerLine === null || positions.closingRuleLine === null ? "unrecognized_composer_boundary"
      : body !== null && body !== normalize(expected) ? "extracted_text_mismatch" : undefined;
    return { ...positions, ...(reason ? { reason } : {}), captureScrollbackLines, windowsOmitted: "unclassified-startup-text" };
  } catch {
    return undefined;
  }
}
