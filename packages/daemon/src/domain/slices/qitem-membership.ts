// Canonical scope-membership matcher (VM-003 + VM-004).
//
// "Which qitems belong to scope X" was answered FOUR inconsistent ways in
// the review pipeline (matchQitems substring > hasActiveQitem JSON-LIKE >
// attentionForTag JSON-LIKE > agentsForSlices exact-equality). This module
// is the ONE canonical membership predicate every consumer shares: the
// documented matchQitems contract (typed tags authoritative, per JSON
// element, comma-legacy-aware) made canonical.

export interface QitemScopeTags {
  slices: Set<string>;
  missions: Set<string>;
}

/** Canonical scope membership from a qitem's raw tags column.
 *  Typed tags AUTHORITATIVE: JSON array parsed per element; each element
 *  comma-split (the legacy CLI form, per the matchQitems contract comment)
 *  and trimmed; exact `slice:`/`mission:` prefix match per token. No
 *  substring semantics live here — the legacy substring tier remains a
 *  matchQitems-local concern behind its zero-typed-rows condition.
 *
 *  TWO-TIER DOCTRINE: the SIGNAL tier (phase / band / attention) answers
 *  from canonical membership ONLY — this function. The DISPLAY tier (the
 *  queue-tab's qitemIds) may carry the gated legacy substring fallback.
 *  Never promote a display-tier match into a signal. */
export function parseScopeTags(rawTags: string | null | undefined): QitemScopeTags {
  const slices = new Set<string>();
  const missions = new Set<string>();
  if (rawTags == null) return { slices, missions };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTags);
  } catch {
    // Malformed JSON -> empty sets (parity with today's catch-blocks).
    return { slices, missions };
  }
  if (!Array.isArray(parsed)) return { slices, missions };

  for (const element of parsed) {
    if (typeof element !== "string") continue;
    // Comma-split the element (the legacy CLI form matchQitems' comment
    // names) and trim at the ELEMENT/token level ONLY — never after the
    // prefix. `slice: X` (space after the colon) therefore yields the name
    // ` X`, not `X`: it is NOT a membership. WHY: the unquoted SQL prefilter
    // `LIKE '%slice:<name>%'` does not match the raw string `slice: X`, so
    // trimming post-prefix would accept a row the prefilter cannot see — an
    // under-selecting prefilter, the exact invariant breach. With token-only
    // trim, any accepted element literally CONTAINS the prefilter needle, so
    // never-under-select holds by construction. (Case/name-drift is NOT
    // normalized in v1 — exact, case-sensitive match.)
    for (const rawToken of element.split(",")) {
      const token = rawToken.trim();
      if (token.startsWith("slice:")) {
        slices.add(token.slice("slice:".length));
      } else if (token.startsWith("mission:")) {
        missions.add(token.slice("mission:".length));
      }
    }
  }
  return { slices, missions };
}
