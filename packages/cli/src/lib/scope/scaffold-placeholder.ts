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

/** PM dogfood #1 (qitem-20260720015700-630eef64) — true when `body` is a
 *  PRESENT section whose EVERY non-blank line is scaffold-placeholder
 *  content: either a bare placeholder line, or a structural list row
 *  (numbered `1.`/`1)`, checkbox `- [ ]`, or bullet `-`/`*`) whose text is a
 *  placeholder — i.e. exactly what the shipped templates scaffold, nothing
 *  authored. This is the SECTION-level pristine test behind per-section
 *  source selection: only a pristine PRD section may yield to an authored
 *  README section; authored/prose/mixed content is NOT pristine and stays
 *  canonical wherever it lives. `null`/blank-only → false (absence is its
 *  own state; a missing section never triggers fallback). */
export function isPristineScaffoldSection(body: string | null): boolean {
  if (body === null) return false;
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  return lines.every((l) => {
    const stripped = l.replace(/^(?:\d+[.)]\s+|-\s*\[[ xX]\]\s*|[-*]\s+)/, "");
    return isScaffoldPlaceholderText(stripped);
  });
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

/** KI-5.3-2 second-face follow-up (row e69daaef; r1 A3 confirmed) — the ONE
 *  proof-contract SOURCE-SELECTION home. Three readers (proof-add, review
 *  compose DELIVERED pairing, both scope-audit twins) previously derived the
 *  fallback target independently and DIVERGED: proof-add derived from SPEC
 *  while compose/audit fell back to README with no SPEC path — evidence
 *  recorded against one contract, displayed against another. Selection order
 *  over SECTION BODIES (each reader keeps its own extractor):
 *    authored PRD  -> "prd"    (canonical, the first-face ruling)
 *    pristine PRD  -> authored SPEC -> "spec"
 *                  -> else authored README -> "readme"
 *                  -> else null (nothing authored; never the placeholder)
 *    absent PRD    -> authored SPEC -> authored README -> null
 *  "Authored" = present and NOT isPristineScaffoldSection. Consumers parse
 *  items from the SELECTED source's body with their shipped parsers. */
export function selectProofContractBody(args: {
  prdBody: string | null;
  specBody: string | null;
  readmeBody: string | null;
}): { source: "prd" | "spec" | "readme" | null; body: string | null } {
  const authored = (b: string | null): boolean => b !== null && !isPristineScaffoldSection(b);
  if (authored(args.prdBody)) return { source: "prd", body: args.prdBody };
  if (authored(args.specBody)) return { source: "spec", body: args.specBody };
  if (authored(args.readmeBody)) return { source: "readme", body: args.readmeBody };
  return { source: null, body: null };
}
