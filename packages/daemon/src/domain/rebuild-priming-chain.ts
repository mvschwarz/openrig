import { join } from "node:path";
import { listRecapChain, RECAP_FILENAME } from "./context-packs/seat-recap-store.js";
import { parseSessionName } from "./session-name.js";

/**
 * OPR.0.5.5.5 (fix round B3) — THE production rebuild priming chain, extracted
 * from the seat route inline so the route and the tests consume ONE
 * implementation. Trust-precedence order is explicit and pinned:
 *
 *   1. current authored `RECAP.md` (highest trust);
 *   2. `LEARNED.md` (seat lineage lessons);
 *   3. the latest restore packet, when the compaction seam's seat-keyed
 *      restore-pending marker names one;
 *   4. superseded recap chain, newest first.
 *
 * The builder only DECLARES addresses; the handover service existence-filters
 * them (a declared-but-missing address is recorded as a named GAP, never
 * silently dropped). An unparseable seat ref is a NAMED empty chain, never a
 * guess.
 */
export function buildRebuildPrimingChain(
  seatRef: string,
  opts: { topologyRoot: string; openrigHome: string },
): { artifacts: Array<{ address: string; label: string }> } | { emptyReason: string } {
  const parsed = parseSessionName(seatRef);
  if (parsed.kind !== "canonical") {
    return { emptyReason: `seat ref '${seatRef}' did not parse as canonical <seat>@<rig> — no durable chain resolved, never guessed` };
  }
  const seatDir = join(opts.topologyRoot, "rigs", parsed.rig, "seats", parsed.member);
  const artifacts = [
    { address: join(seatDir, RECAP_FILENAME), label: "authored seat recap (highest trust)" },
    { address: join(seatDir, "LEARNED.md"), label: "seat lineage lessons" },
    ...listRecapChain(seatDir).reverse().map((entry, index) => ({
      address: entry.path,
      label: `superseded recap (${index + 1} generation${index === 0 ? "" : "s"} back)`,
    })),
  ];
  return { artifacts };
}
