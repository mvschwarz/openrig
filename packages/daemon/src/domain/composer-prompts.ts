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

/** A numbered option line (`❯ 1. Yes`, `› 2. No`): a prompt selection, never staged input. */
export const COMPOSER_SELECTION_PATTERN = new RegExp(`^${promptChar}\\s*\\d+\\.\\s`);
/** Same selection shape, matched line-wise across a multi-line scan window. */
export const COMPOSER_SELECTION_SCAN_PATTERN = new RegExp(`^${promptChar}\\s*\\d+\\.\\s`, "m");
/** Empty composer: prompt glyph, optional whitespace, end of line. */
export const COMPOSER_EMPTY_PATTERN = new RegExp(`^${promptChar}\\s*$`);
/** Codex renders a fixed placeholder in its empty composer. */
export const COMPOSER_EMPTY_CODEX_PLACEHOLDER_PATTERN = /^›\s+Ask Codex to do anything\s*$/;
/** Draft present: prompt glyph followed by non-whitespace text. */
export const COMPOSER_DRAFT_PATTERN = new RegExp(`^${promptChar}\\s+\\S`);
/** True when a line begins with a composer prompt glyph. */
export const COMPOSER_PROMPT_LINE_PATTERN = new RegExp(`^${promptChar}`);

/**
 * Index of the last composer prompt line in a capture, or -1 when the capture
 * carries none. Only the last one can be the current input; everything above it
 * is transcript history and a bare Enter there could drive an old prompt.
 */
export function findComposerInputLineIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (COMPOSER_PROMPT_LINE_PATTERN.test(lines[i]!.trimStart())) return i;
  }
  return -1;
}

/** Strip a leading prompt glyph from a composer line. */
export function stripComposerPromptGlyph(line: string): string {
  return line.replace(COMPOSER_PROMPT_LINE_PATTERN, "");
}
