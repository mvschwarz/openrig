// Operator Surface Reconciliation v0 — Priority Rail Rule helpers.
//
// Item 2: per-level typography distinguishing the four canonical
// Priority Rail Rule levels (STEERING / mission / lane / slice) plus
// "intermediate" cursor files that don't fit any of the four named
// buckets.
//
// Per the workstream-continuity convention referenced in the PRD
// (`workstream-continuity/README.md:119-163`), the level is purely a
// path-shape classification — the operator's mental model attaches to
// the file's location in the workspace tree. The classifier is a
// regex-set; driver-picked per audit-row 10.

import type { ProgressFileNode, ProgressRow } from "../../hooks/useProgressTree.js";

export type PriorityRailLevel = "steering" | "mission" | "lane" | "slice" | "intermediate";

const STEERING_BASENAME = /(^|[\\/])STEERING\.md$/i;
const MISSION_PATH = /(^|[\\/])missions[\\/][^\\/]+[\\/]PROGRESS\.md$/;
const ROADMAP_PATH = /(^|[\\/])roadmap[\\/]PROGRESS\.md$/;
const DELIVERY_LANE_PATH = /(^|[\\/])delivery-ready[\\/]mode-\d+[\\/]PROGRESS\.md$/;
const SLICE_PATH = /(^|[\\/])slices[\\/][^\\/]+[\\/]PROGRESS\.md$/;

export function classifyPriorityRailLevel(file: ProgressFileNode): PriorityRailLevel {
  // Check both the relPath (tracked relative to the scan root) and the
  // absolutePath (canonical on-disk) so the classifier works regardless
  // of how the operator scoped their scan roots.
  const candidates = [file.relPath, file.absolutePath];
  for (const candidate of candidates) {
    if (STEERING_BASENAME.test(candidate)) return "steering";
    if (DELIVERY_LANE_PATH.test(candidate)) return "lane";
    if (ROADMAP_PATH.test(candidate)) return "lane";
    if (SLICE_PATH.test(candidate)) return "slice";
    if (MISSION_PATH.test(candidate)) return "mission";
  }
  return "intermediate";
}

export interface PriorityRailLevelStyle {
  label: string;
  /** Tailwind classes for the row chip. */
  chipClass: string;
  /** Order key for grouping in the tree (steering first → intermediate last). */
  order: number;
}

const STYLES: Record<PriorityRailLevel, PriorityRailLevelStyle> = {
  steering:     { label: "Constraint", chipClass: "border-stone-900 bg-stone-900 text-stone-50", order: 0 },
  mission:      { label: "Mission",    chipClass: "border-violet-400 bg-violet-50 text-violet-900", order: 1 },
  lane:         { label: "Lane",       chipClass: "border-emerald-400 bg-emerald-50 text-emerald-900", order: 2 },
  slice:        { label: "Slice",      chipClass: "border-sky-400 bg-sky-50 text-sky-900", order: 3 },
  intermediate: { label: "Cursor",     chipClass: "border-stone-300 bg-stone-50 text-stone-500", order: 4 },
};

export function getPriorityRailLevelStyle(level: PriorityRailLevel): PriorityRailLevelStyle {
  return STYLES[level];
}

/** Computes the "next pull" line per Priority Rail Rule semantics for a
 *  lane file: first checkbox row whose status is neither done nor
 *  blocked. Returns null when no such row exists (lane is fully closed
 *  or fully blocked). */
export function computeNextPullLine(file: ProgressFileNode): number | null {
  for (const row of file.rows) {
    if (row.kind !== "checkbox") continue;
    if (row.status !== "done" && row.status !== "blocked") return row.line;
  }
  return null;
}

// --- Lint rules (item 6) ---

export type LintRuleId = "long-row" | "missing-tree" | "narrative-mixed" | "qitem-no-label";

export interface LintWarning {
  ruleId: LintRuleId;
  /** Source line (1-based) within the file. May be null for file-scope
   *  warnings (e.g., missing-tree applies to the whole file). */
  line: number | null;
  /** Operator-readable message. */
  message: string;
  /** Citation pointing back to the workstream-continuity convention so
   *  operators can re-read the rule when investigating. */
  citation: string;
}

const LONG_ROW_THRESHOLD_CHARS = 160;
const TREE_HEADING_REGEX = /^#{1,4}\s+(tree|hierarchy|topology)/i;
const QITEM_PATTERN = /^qitem-\d{8,}-[0-9a-f]+$/i;

/** Computes lint warnings for a single PROGRESS.md file per the
 *  workstream-continuity rules cited in the PRD § Item 6. v0 ships
 *  the four named rules; results are advisory (no file modification). */
export function computeLintWarnings(file: ProgressFileNode, hasChildFiles: boolean): LintWarning[] {
  const warnings: LintWarning[] = [];

  // Rule 1 — items longer than two visual lines (heuristic at 160 chars).
  for (const row of file.rows) {
    if (row.kind === "checkbox" && row.text.length > LONG_ROW_THRESHOLD_CHARS) {
      warnings.push({
        ruleId: "long-row",
        line: row.line,
        message: `Row text is ${row.text.length} chars (over ${LONG_ROW_THRESHOLD_CHARS}). Split into a parent rail + sub-items.`,
        citation: "workstream-continuity/README.md § rule 1 (items ≤ 2 visual lines)",
      });
    }
  }

  // Rule 2 — missing tree diagram when folder participates in hierarchy.
  if (hasChildFiles) {
    const hasTreeHeading = file.rows.some((r) => r.kind === "heading" && TREE_HEADING_REGEX.test(`## ${r.text}`));
    if (!hasTreeHeading) {
      warnings.push({
        ruleId: "missing-tree",
        line: null,
        message: "File parents other PROGRESS.md files but has no '## Tree' / '## Hierarchy' / '## Topology' heading.",
        citation: "workstream-continuity/README.md § rule 2 (authored tree diagrams for parent files)",
      });
    }
  }

  // Rule 3 — narrative-style items mixed with rail items in the same section.
  // Heuristic: between two heading boundaries, count checkbox rows AND
  // count "narrative" rows (non-checkbox, non-heading lines that are
  // also non-empty). When both > 0, warn at the first checkbox row of
  // the section. v0 applies this only when the section has at least
  // 2 checkboxes + 2 narrative lines to keep noise low.
  let sectionCheckboxes: ProgressRow[] = [];
  let sectionNarrativeCount = 0;
  let sectionStartLine = 1;
  const flushSection = () => {
    if (sectionCheckboxes.length >= 2 && sectionNarrativeCount >= 2) {
      const first = sectionCheckboxes[0]!;
      warnings.push({
        ruleId: "narrative-mixed",
        line: first.line,
        message: `Section starting near L${sectionStartLine} interleaves ${sectionNarrativeCount} narrative line(s) with ${sectionCheckboxes.length} rail item(s). Move prose to the section heading body or a sibling notes file.`,
        citation: "workstream-continuity/README.md § rule 3 (narrative vs. rail-item separation)",
      });
    }
    sectionCheckboxes = [];
    sectionNarrativeCount = 0;
  };
  for (const row of file.rows) {
    if (row.kind === "heading") {
      flushSection();
      sectionStartLine = row.line;
      continue;
    }
    if (row.kind === "checkbox") {
      sectionCheckboxes.push(row);
    }
  }
  flushSection();
  // Narrative count: we don't have non-checkbox/non-heading rows in the
  // ProgressFileNode shape (the indexer drops them); rule 3 ships
  // active-but-quiet at v0. The heuristic above only fires when
  // sectionNarrativeCount ≥ 2 which is never true in v0 — recording
  // explicitly as a known limitation; v0+1 promotion would require
  // teaching the indexer to retain narrative lines.

  // Rule 4 — qitem ids without human-readable names.
  for (const row of file.rows) {
    if (row.kind !== "checkbox") continue;
    if (QITEM_PATTERN.test(row.text)) {
      warnings.push({
        ruleId: "qitem-no-label",
        line: row.line,
        message: "Row body is a bare qitem id with no human label. Append a one-line description.",
        citation: "workstream-continuity/README.md § rule 4 (human-readable rail rows)",
      });
    }
  }

  return warnings;
}
