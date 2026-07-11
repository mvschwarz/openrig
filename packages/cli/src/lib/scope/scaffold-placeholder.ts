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

/** The generic acceptance triple scaffolded by
 *  `packages/cli/src/lib/scope-templates/slice-progress.md` — exact trimmed
 *  literals, sync-tested against the shipped template so constant/template
 *  drift fails CI instead of silently reviving the bogus pristine count. */
export const GENERIC_SCAFFOLD_ACCEPTANCE: readonly string[] = [
  "Implementation complete",
  "Tests passing",
  "Review approved",
];
