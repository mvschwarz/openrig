// REGISTRY I3 (ruling 64f1dbdf) — the fuzzy command palette MODEL (pure; the render
// overlay and the input wiring consume this). PM pins carried:
//   - aliases are FIRST-CLASS in the fuzzy match (pin 5);
//   - context-unavailable entries render DIMMED-WITH-REASON, never hidden;
//   - execution is BYTE-EQUAL to direct typing: the palette emits a COMMAND LINE that
//     rides parseCommand -> dispatch (the BR-9 one-resolver path) — argless entries
//     execute the line verbatim, argful entries PRE-FILL the command bar.
import type { CommandEntry } from "./registry.js";

export interface PaletteRow {
  entry: CommandEntry;
  /** True when the entry's context is satisfied in the CURRENT context. */
  available: boolean;
  /** When unavailable: the honest reason naming the required context. */
  reason?: string;
  score: number;
}

/** Subsequence fuzzy score: exact-prefix > word-prefix > subsequence; alias hits use the
 *  best-scoring name among canonical + aliases (first-class, pin 5). 0 = no match. */
function scoreOne(query: string, candidate: string): number {
  if (query === "") return 1;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (c === q) return 1000 - c.length;
  if (c.startsWith(q)) return 800 - c.length;
  // subsequence
  let qi = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci += 1) {
    if (c[ci] === q[qi]) qi += 1;
  }
  return qi === q.length ? 400 - c.length : 0;
}

function scoreEntry(query: string, entry: CommandEntry): number {
  return Math.max(scoreOne(query, entry.name), ...entry.aliases.map((a) => scoreOne(query, a)));
}

export function filterPalette(
  query: string,
  registry: readonly CommandEntry[],
  currentContext: string,
): PaletteRow[] {
  const rows: PaletteRow[] = [];
  for (const entry of registry) {
    const score = scoreEntry(query, entry);
    if (score === 0) continue;
    const available = entry.context === "always" || entry.context === currentContext;
    rows.push({
      entry,
      available,
      ...(available ? {} : { reason: `needs ${entry.context} context` }),
      score,
    });
  }
  // Stable: score desc, then registry order (rows carry insertion order for ties).
  return rows.sort((a, b) => b.score - a.score);
}

/** The execute contract: argless entries EXECUTE their canonical line verbatim (byte-equal
 *  to typing it); argful entries PRE-FILL the command bar for completion — the palette
 *  never fabricates arguments. */
export function paletteExecuteLine(entry: CommandEntry): { mode: "execute" | "prefill"; line: string } {
  if (entry.prefix) return { mode: "prefill", line: entry.name };
  return entry.args ? { mode: "prefill", line: `${entry.name} ` } : { mode: "execute", line: entry.name };
}
