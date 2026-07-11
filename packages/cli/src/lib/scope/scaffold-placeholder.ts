// release-0.4.7 intent-stage/scaffold-projection — the ONE scaffold-recognition
// grammar: "this text is shipped-template placeholder, not authored content."
//
// PARITY CONTRACT (arch ruling 2026-07-11, intent-stage plan AR-1 + P1 pin):
// this file is a BYTE-EQUIVALENT TWIN — it exists identically at
//   packages/cli/src/lib/scope/scaffold-placeholder.ts
//   packages/daemon/src/domain/scope/scaffold-placeholder.ts
// and byte-equivalence is CI-enforced by scope-audit-parity CLASSIFIER_FILES.
// Do NOT diverge the copies, and do NOT "deduplicate" them into one file in a
// cleanup pass — a true shared module importable by both packages does not
// exist in this layout, so the twin-plus-parity arrangement IS the
// single-grammar guarantee (one grammar, three consumers: review compose,
// slice-detail-projector, and both scope-audit twins). If the layout ever
// gains a real shared package, the twins collapse into it then — not before.
//
// Grammar (arch-stated): trimmed text fully bracket-wrapped = a scaffold
// placeholder — the shipped-template marker, verified template-by-template
// across scope-templates/*.md. Honest edge (test-pinned, not gated): ANY
// character outside the brackets makes it real; a fully-bracket-wrapped REAL
// deliverable is written in template grammar. `[a] and [b]` starts with `[`
// and ends with `]`, so it classifies placeholder — arch-grammar-faithful,
// deliberately not special-cased (no private grammar).

/** True when `text`, trimmed, is fully bracket-wrapped (`[...]`) — the
 *  shipped scaffold-template placeholder marker, i.e. NOT authored content. */
export function isScaffoldPlaceholderText(text: string): boolean {
  return /^\[.*\]$/.test(text.trim());
}

/** release-0.4.7 placeholder-suppression completeness — true when `body`
 *  carries at least one numbered item (`1.` OR `1)` form) whose text is NOT a
 *  scaffold placeholder: the ONE authored-numbered-item grammar. Consumers:
 *  review compose `hasAuthoredMiniReqs` + BOTH scope-audit mini-reqs arms —
 *  one predicate heals the IF-3 dot/paren grammar divergence and the audit
 *  arm's placeholder-blindness together (arch MB-AR-1 primary shape).
 *  Prose-only or bullet-only bodies are deliberately NOT authored — the
 *  numbered tier is where approval starts (reviewer-L1 ruling 2026-07-11,
 *  intent-stage gate). `null` → false. */
export function hasAuthoredNumberedItem(body: string | null): boolean {
  if (body === null) return false;
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (m && !isScaffoldPlaceholderText(m[1]!.trim())) return true;
  }
  return false;
}

/** release-0.4.7 placeholder-suppression completeness — true when EVERY
 *  non-blank line of `block` is a scaffold placeholder: the section-level
 *  "nothing authored here" test. Per-LINE deliberately, not a whole-string
 *  trim — a two-line `[a]\n[b]` body is placeholder-only per line but would
 *  fail the single-line regex (the multi-line honest case, arch MB-AR-2).
 *  `null`/empty/blank-only → false: absence is its own state; callers keep
 *  their existing null handling. */
export function isPlaceholderOnlyBlock(block: string | null): boolean {
  if (block === null) return false;
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  return lines.every((l) => isScaffoldPlaceholderText(l));
}

/** The generic acceptance triple scaffolded by
 *  `packages/cli/src/lib/scope-templates/slice-progress.md` — exact trimmed
 *  literals, sync-tested against the shipped template so constant/template
 *  drift fails CI instead of silently reviving the bogus pristine count. */
export const GENERIC_SCAFFOLD_ACCEPTANCE: readonly string[] = [
  "Implementation complete",
  "Tests passing",
  "Review approved",
];
