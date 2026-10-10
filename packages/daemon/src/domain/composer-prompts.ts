import stringWidth from "string-width";

/**
 * One place for the composer/prompt glyphs and the shapes built from them.
 *
 * The send-readiness classifier, the staged-input inspector, the startup
 * submission guard and the CLI's staged-at-prompt detector all have to agree on
 * what a composer prompt looks like. They used to each carry their own copy:
 * Claude Code draws `❯`, Codex draws `›`, and Codex 0.153 variants draw `»`
 * (#79). A renderer change or a new glyph must land here once, so the send
 * verify path and the staged-input check can never disagree.
 */

/** Every glyph a harness has been observed to draw as its composer prompt. */
export const COMPOSER_PROMPT_CHARS = ["❯", "›", "»"] as const;

/** Character-class fragment (without brackets) for the prompt glyphs. */
export const COMPOSER_PROMPT_CLASS = COMPOSER_PROMPT_CHARS.join("");

const promptChar = `[${COMPOSER_PROMPT_CLASS}]`;

/**
 * The glyph set for one runtime. A Claude pane uses `❯`; a Codex pane uses `›`
 * (and `»` on 0.153 variants). Only an unknown runtime takes the union, because
 * a multi-line draft's continuation can itself start with another harness's
 * glyph (a quoted Codex line inside a Claude draft, say), and taking the last
 * such line as the composer would misread the staged text.
 */
export function composerPromptClassForRuntime(runtime: string | null | undefined): string {
  if (runtime === "claude-code") return "❯";
  if (runtime === "codex") return "›»";
  return COMPOSER_PROMPT_CLASS;
}

/** Build a line-anchored pattern for one prompt-glyph set. */
function promptPattern(promptClass: string, suffix: string, flags = ""): RegExp {
  return new RegExp(`^[${promptClass}]${suffix}`, flags);
}

/** A numbered option line (`❯ 1. Yes`, `› 2. No`): a prompt selection, never staged input. */
export const COMPOSER_SELECTION_PATTERN = promptPattern(COMPOSER_PROMPT_CLASS, "\\s*\\d+\\.\\s");
/** Same selection shape, matched line-wise across a multi-line scan window. */
export const COMPOSER_SELECTION_SCAN_PATTERN = promptPattern(COMPOSER_PROMPT_CLASS, "\\s*\\d+\\.\\s", "m");
/**
 * The broader numbered-option exclusion the staged-input checks always had:
 * number plus dot, with or without a space (`❯ 1.Yes` is still a selector). A
 * compact option must never be confirmed or healed as staged text.
 */
export function composerSelectionPrefixPattern(promptClass: string = COMPOSER_PROMPT_CLASS): RegExp {
  return promptPattern(promptClass, "\\s*\\d+\\.");
}
/** Empty composer: prompt glyph, optional whitespace, end of line. */
export const COMPOSER_EMPTY_PATTERN = promptPattern(COMPOSER_PROMPT_CLASS, "\\s*$");
/** Codex renders a fixed placeholder in its empty composer (`›` or 0.153's `»`). */
export const COMPOSER_EMPTY_CODEX_PLACEHOLDER_PATTERN = /^[›»]\s+Ask Codex to do anything\s*$/;
/** Draft present: prompt glyph followed by non-whitespace text. */
export const COMPOSER_DRAFT_PATTERN = promptPattern(COMPOSER_PROMPT_CLASS, "\\s+\\S");
/** True when a line begins with any composer prompt glyph (union default). */
export const COMPOSER_PROMPT_LINE_PATTERN = promptPattern(COMPOSER_PROMPT_CLASS, "");

/**
 * Index of the last composer prompt line in a capture, or -1 when the capture
 * carries none. Only the last one can be the current input; everything above it
 * is transcript history and a bare Enter there could drive an old prompt.
 * `promptClass` scopes the glyphs to a known runtime; the union is the default
 * for callers that have no runtime (the advisory classifier and CLI detector).
 */
export function findComposerInputLineIndex(lines: string[], promptClass: string = COMPOSER_PROMPT_CLASS): number {
  const pattern = promptPattern(promptClass, "");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pattern.test(lines[i]!.trimStart())) return i;
  }
  return -1;
}

/** Strip a leading prompt glyph from a composer line. */
export function stripComposerPromptGlyph(line: string, promptClass: string = COMPOSER_PROMPT_CLASS): string {
  return line.replace(promptPattern(promptClass, ""), "");
}

/** Read the prompt once for both advisory draft recognition and cursor-bound
 * input checks. Keep the one prompt-space separate from authored whitespace.
 */
export function readComposerPromptLine(line: string, promptClass: string = COMPOSER_PROMPT_CLASS) {
  const trimmed = line.trimStart();
  const body = stripComposerPromptGlyph(trimmed, promptClass);
  if (body === trimmed || (body !== "" && !/^\s/.test(body))) return null;
  const indent = line.slice(0, line.length - trimmed.length);
  return { indent, glyph: trimmed[0]!, text: body.slice(1), prefix: indent.length + 2 };
}

/**
 * Distinct prompt glyphs in the capture up to and including `inputIndex`.
 * The walk does not stop at a blank line or a rule: a multi-line draft can
 * hold either, and the ambiguous unknown-runtime read has to see the
 * unrelated first line that precedes them.
 */
export function composerGlyphKindsInBlock(lines: string[], inputIndex: number): Set<string> {
  const kinds = new Set<string>();
  for (let i = inputIndex; i >= 0; i--) {
    const first = lines[i]!.trimStart()[0];
    if (first !== undefined && (COMPOSER_PROMPT_CHARS as readonly string[]).includes(first)) kinds.add(first);
  }
  return kinds;
}

/**
 * True when an unknown-runtime read of this composer block is ambiguous: the
 * block holds more than one prompt glyph kind, so there is no runtime to say
 * which line is the live input. A caller must keep the union for unknown
 * runtimes but fail closed here, exactly as the pre-shared-matcher check did.
 */
export function composerPromptIsAmbiguous(lines: string[], inputIndex: number, promptClass: string = COMPOSER_PROMPT_CLASS): boolean {
  if (promptClass !== COMPOSER_PROMPT_CLASS) return false;
  return composerGlyphKindsInBlock(lines, inputIndex).size > 1;
}

export interface ComposerSnapshot {
  screen: string;
  cursor: { x: number; y: number; width: number; height: number };
  inMode: boolean;
}

export interface ComposerOwnership { text: string; frame: string }

export interface ComposerInput {
  state: "empty" | "text" | "unknown";
  rows: string[];
  columns: number;
  frame?: string;
  pasteMatchesExpected?: boolean;
  cursorAtEnd: boolean;
  collapsedPaste: string | null;
  /** A proven display-only suffix, so readiness can reuse the same input read. */
  ghost?: { line: number; offset: number; continuationRows: number };
}

export const COMPOSER_COLLAPSED_PASTE_PATTERN = /^\[Pasted text #\d+ \+(\d+) lines\]$/;

/** Preserve characters and spaces within rows. Only a real line break, a full
 * terminal row, or a word that cannot fit may explain a rendered row boundary.
 */
export function composerContainsOwnedText(input: ComposerInput, expected: string): boolean {
  if (input.state !== "text" || !input.cursorAtEnd || input.collapsedPaste || !input.rows.length) return false;
  const text = expected.replace(/\r\n/g, "\n");
  let offsets = new Set([0]);
  for (let index = 0; index < input.rows.length; index++) {
    const row = input.rows[index]!;
    const next = new Set<number>();
    for (const offset of offsets) {
      if (!text.startsWith(row, offset)) continue;
      const end = offset + row.length;
      if (index === input.rows.length - 1) { if (end === text.length) return true; continue; }
      if (text[end] === "\n") next.add(end + 1);
      if (stringWidth(row) >= input.columns) next.add(end);
      if (text[end] === " ") {
        const word = /^\S+/.exec(text.slice(end + 1))?.[0] ?? "";
        if (word && stringWidth(row + " " + word) > input.columns) next.add(end + 1);
      }
    }
    offsets = next;
    if (!offsets.size) return false;
  }
  return false;
}

/** An opaque label may be remembered only immediately after this lease pasted
 * the text. Subsequent submission requires that same complete label and cursor.
 */
export function ownCollapsedPaste(input: ComposerInput, expected: string): string | null {
  if (input.collapsedPaste && input.cursorAtEnd && input.pasteMatchesExpected) return input.collapsedPaste;
  const match = input.collapsedPaste && input.cursorAtEnd ? COMPOSER_COLLAPSED_PASTE_PATTERN.exec(input.collapsedPaste) : null;
  return match && Number(match[1]) === expected.split("\n").length - 1 ? input.collapsedPaste : null;
}
