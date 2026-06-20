// OPR.0.4.0.33 — pure, surgical markdown editors for PROGRESS rails.
//
// These back `rig scope ... progress`. They consume the UI parser
// contract in packages/daemon/src/domain/progress/progress-indexer.ts:
//   - title comes from the FIRST `# H1` only (frontmatter is skipped),
//   - section hierarchy from `##`/`###`/`####` headings,
//   - rows from `- [ ]` / `- [x]` / `- [~]` checkbox lines.
// So every edit preserves the `# H1` + the YAML frontmatter verbatim
// and writes rows in exactly that shape. The functions are pure (string
// in, string out) so the command layer stays thin and the behavior is
// unit-testable without a filesystem.

import { ScopeCliError } from "./types.js";

export type ProgressStatus = "active" | "done" | "blocked";

export const PROGRESS_STATUSES: ReadonlyArray<ProgressStatus> = ["active", "done", "blocked"];

export const DEFAULT_PROGRESS_SECTION = "Rail";

/** Map a status word to the single indexer indicator character. */
export function statusIndicator(status: ProgressStatus): " " | "x" | "~" {
  switch (status) {
    case "active": return " ";
    case "done": return "x";
    case "blocked": return "~";
  }
}

function indicatorToStatus(indicator: string): ProgressStatus {
  const c = indicator.toLowerCase();
  if (c === "x") return "done";
  if (c === "~") return "blocked";
  return "active";
}

/** Validate + narrow an arbitrary string to a ProgressStatus, or throw
 *  the 3-part error. The status vocabulary is the ONLY three the indexer
 *  understands. */
export function parseStatus(raw: string): ProgressStatus {
  if ((PROGRESS_STATUSES as ReadonlyArray<string>).includes(raw)) {
    return raw as ProgressStatus;
  }
  throw new ScopeCliError({
    fact: `Unknown --status "${raw}".`,
    consequence: "No progress row was written.",
    action: `Use one of: ${PROGRESS_STATUSES.join(", ")}.`,
  });
}

// Indexer-aligned row matcher: optional indent, optional `- `/`* ` bullet,
// `[ x ~]` indicator, then the row text.
const ROW_RE = /^(\s*)(?:[-*]\s+)?\[([ xX~])\]\s+(.+?)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/** Index of the first body line (after any leading YAML frontmatter). */
function bodyStartIndex(lines: string[]): number {
  if ((lines[0] ?? "").trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") return i + 1;
  }
  return 0; // unterminated frontmatter — treat as no frontmatter
}

export interface ProgressEditResult {
  content: string;
  changed: boolean;
}

/**
 * Append a `- [<indicator>] <text>` row under `## <section>`.
 * - Creates the `## <section>` heading (appended after the last existing
 *   section) when it is absent.
 * - Idempotent: an identical (section, text, status) row is a no-op.
 * - Refuses to create a conflicting duplicate (same text, different
 *   status) — that is a `--set` operation, not an `--add`.
 * - Never touches the frontmatter, the `# H1`, or unrelated lines.
 */
export function addProgressRow(
  content: string,
  opts: { section: string; text: string; status: ProgressStatus },
): ProgressEditResult {
  const section = opts.section.trim();
  const text = opts.text.trim();
  if (!text) {
    throw new ScopeCliError({
      fact: "The --add row text is empty.",
      consequence: "No progress row was written.",
      action: 'Pass a non-empty row, e.g. --add "Guard approved".',
    });
  }
  const newRow = `- [${statusIndicator(opts.status)}] ${text}`;
  const lines = content.split("\n");
  const start = bodyStartIndex(lines);

  // Locate the target section heading.
  let sectionIdx = -1;
  for (let i = start; i < lines.length; i++) {
    const h = lines[i]!.match(HEADING_RE);
    if (h && h[2]!.trim() === section) { sectionIdx = i; break; }
  }

  if (sectionIdx === -1) {
    // Create the section, appended after the last existing content.
    let end = lines.length;
    while (end > start && lines[end - 1]!.trim() === "") end--;
    const head = lines.slice(0, end);
    const rebuilt = [...head, "", `## ${section}`, "", newRow, ""].join("\n");
    return { content: rebuilt, changed: true };
  }

  // Section block = [sectionIdx+1, nextHeadingOrEOF).
  let blockEnd = lines.length;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i]!)) { blockEnd = i; break; }
  }

  // Idempotency / conflict scan within the section.
  for (let i = sectionIdx + 1; i < blockEnd; i++) {
    const cb = lines[i]!.match(ROW_RE);
    if (cb && cb[3]!.trim() === text) {
      const current = indicatorToStatus(cb[2]!);
      if (current === opts.status) return { content, changed: false };
      throw new ScopeCliError({
        fact: `A row "${text}" already exists in section "${section}" with status ${current}.`,
        consequence: "Refusing to add a conflicting duplicate row.",
        action: `Use: rig scope ... progress --set "${text}" --status ${opts.status} to change its status.`,
      });
    }
  }

  // Insert after the last non-blank line in the section block.
  let insertAt = sectionIdx + 1;
  for (let i = sectionIdx + 1; i < blockEnd; i++) {
    if (lines[i]!.trim() !== "") insertAt = i + 1;
  }
  lines.splice(insertAt, 0, newRow);
  return { content: lines.join("\n"), changed: true };
}

/**
 * Rewrite the indicator of the single row whose trimmed text EXACTLY
 * matches `text`. Row selection is exact-trimmed-text (not line number,
 * not a generated id — the indexer mints neither).
 * - 0 matches → error (names the missing text).
 * - >1 matches → error (ambiguous; v0 refuses rather than guess).
 * - Idempotent: setting a row to its current status is a no-op.
 * - Rewrites ONLY the matched line's indicator char; the rest is
 *   preserved byte-for-byte.
 */
export function setProgressRow(
  content: string,
  opts: { text: string; status: ProgressStatus },
): ProgressEditResult {
  const text = opts.text.trim();
  const lines = content.split("\n");
  const start = bodyStartIndex(lines);

  const matches: number[] = [];
  for (let i = start; i < lines.length; i++) {
    const cb = lines[i]!.match(ROW_RE);
    if (cb && cb[3]!.trim() === text) matches.push(i);
  }

  if (matches.length === 0) {
    throw new ScopeCliError({
      fact: `No progress row matches the exact text "${text}".`,
      consequence: "Nothing was changed.",
      action: 'Check the row text (exact, trimmed match), or add it with --add. List rows with: rig scope ... show.',
    });
  }
  if (matches.length > 1) {
    throw new ScopeCliError({
      fact: `${matches.length} rows match the text "${text}" (ambiguous).`,
      consequence: "v0 refuses to guess which row to update; nothing was changed.",
      action: "Make the row text unique, then retry.",
    });
  }

  const i = matches[0]!;
  const indMatch = lines[i]!.match(/\[([ xX~])\]/)!;
  if (indicatorToStatus(indMatch[1]!) === opts.status) {
    return { content, changed: false };
  }
  lines[i] = lines[i]!.replace(/\[([ xX~])\]/, `[${statusIndicator(opts.status)}]`);
  return { content: lines.join("\n"), changed: true };
}
