// OPR.0.4.7 slice-04 Stage-3 Lever A — plan-lock snapshot derivation.
//
// PURE derivation of a slice's `locked-artifacts` plan set from its README +
// IMPLEMENTATION-PRD content strings — NO fs here; the scope-approve read shell
// supplies both (readme = the approve originalBytes, prd = tryReadPRD or null).
// Reuses the EXPORTED Review helpers directly (D1 — no shared extraction) so the
// derived plan has source-selection/extraction parity with Review (no byte-equality
// claim). Determinism: stable order (PRD -> selected proof-contract plannedRefs ->
// intent visuals), normalized-path dedup, first source wins.

import type { LockedArtifact } from "../review/types.js";
import {
  extractProofContractSelected,
  extractSection,
  extractMediaRefs,
  sliceRelativeMediaPath,
} from "../review/compose.js";
import { isScaffoldPlaceholderText } from "./scaffold-placeholder.js";

/**
 * Derive the ordered, deduped `locked-artifacts` set for a slice plan-lock.
 * @param readme slice README content (the approve read shell's originalBytes); null if absent.
 * @param prd slice IMPLEMENTATION-PRD content; null when missing/unreadable (fail-open).
 */
export function derivePlanLockArtifacts(readme: string | null, prd: string | null, spec: string | null = null): LockedArtifact[] {
  const out: LockedArtifact[] = [];
  const seen = new Set<string>(); // dedup by NORMALIZED path; first source wins

  // Slice-relative + posix-normalize: reject absolute `/…` and `../`-escape, and
  // collapse `mockups/./d.png` and `mockups/d.png` to one entry (first wins).
  // nameFromPath: D4 — an intent-visual entry's name is its EMITTED (normalized)
  // path, so the name never carries a pre-normalization raw ref (e.g. `mockups/./x.png`).
  const add = (name: string, ref: string, kind: string, nameFromPath = false): void => {
    // Reject any URI-scheme ref (http/https/data/...) BEFORE normalization: every
    // locked-artifact path is slice-relative. Intent refs are http-filtered by
    // extractMediaRefs, but proof-contract plannedRefs are not — enforce it here.
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return; // RFC-3986 scheme syntax
    const norm = sliceRelativeMediaPath(ref, "");
    if (norm === null) return; // absolute / escape — never a locked artifact
    if (seen.has(norm)) return; // first source wins
    seen.add(norm);
    out.push({ name: nameFromPath ? norm : name, path: norm, kind });
  };

  // 1. PRD — always pinned first: the EXPECTED spec path, even when the PRD file
  //    is missing/unreadable (Guard #4). A missing PRD simply adds no plannedRefs.
  add("Implementation PRD", "IMPLEMENTATION-PRD.md", "spec");

  // 2. Selected proof-contract plannedRefs — an authored README section wins over
  //    a pristine-scaffold PRD section (extractProofContractSelected, README-wins).
  for (const item of extractProofContractSelected(prd, readme, spec).items) {
    if (!item.plannedRef) continue;
    add(item.text || item.plannedRef, item.plannedRef, "mockup"); // name = item text, path fallback
  }

  // 3. Intent visuals — README `## Intent visual` media refs, UNLESS the section
  //    is N/A (the section-suppression semantics the scope audit uses).
  const visual = extractSection(readme, "Intent visual");
  if (visual !== null && !/\bN\/A\b/i.test(visual)) {
    for (const ref of extractMediaRefs(visual)) {
      add(ref, ref, "mockup", true); // deterministic name = the emitted (normalized) path (D4)
    }
  }

  return out;
}

/**
 * True when a DERIVED plan-lock set would freeze nothing anybody authored: the set is only the
 * unconditional PRD pin, and the PRD file is missing or still shipped-template scaffold (no authored
 * intent prose, no authored mini-req, no authored proof-contract row — the ONE scaffold grammar).
 *
 * A plan-lock's entire meaning is "THIS artifact set is what gets built"; letting the default pin a
 * placeholder writes the strongest structural claim in the SDLC with content nobody chose. Two live
 * locks did exactly that before this check existed. Approve refuses on this predicate unless the
 * stamper names the set explicitly.
 */
export function isContentlessPlanLockSet(prd: string | null, artifacts: LockedArtifact[]): boolean {
  if (artifacts.length > 1) return false; // plannedRefs / intent visuals = chosen content beyond the pin
  if (prd === null) return true; // the pin names a file that does not exist / cannot be read
  return !prdHasAuthoredContent(prd);
}

/** Any line that survives stripping frontmatter, HTML comments, headings, and list/checkbox markers,
 *  and is not the shipped bracket-placeholder grammar, is authored content — free-prose PRDs count,
 *  only the untouched scaffold (and emptiness) does not. */
function prdHasAuthoredContent(prd: string): boolean {
  const body = prd
    .replace(/^---\n[\s\S]*?\n---\n?/, "") // frontmatter
    .replace(/<!--[\s\S]*?-->/g, ""); // scaffold guidance comments
  for (const rawLine of body.split("\n")) {
    let line = rawLine.trim();
    if (line.length === 0) continue;
    if (/^#{1,6}\s/.test(line)) continue; // headings are template structure
    line = line.replace(/^(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, ""); // list / checkbox markers
    if (line.length === 0) continue;
    if (isScaffoldPlaceholderText(line)) continue;
    return true;
  }
  return false;
}
