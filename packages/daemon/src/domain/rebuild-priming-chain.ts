import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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
    ...restorePacketLeg(seatRef, opts.openrigHome),
    ...listRecapChain(seatDir).reverse().map((entry, index) => ({
      address: entry.path,
      label: `superseded recap (${index + 1} generation${index === 0 ? "" : "s"} back)`,
    })),
  ];
  return { artifacts };
}

/**
 * The latest restore packet, read from the compaction seam's seat-keyed
 * restore-pending marker (`$OPENRIG_HOME/compaction/restore-pending/
 * <sanitized-session>.json`, written by the shipped precompact hook). The
 * marker's `outputDir` IS the packet address recorded by the production
 * writer — nothing here invents a format or guesses a path.
 *
 * - valid marker (parses, non-empty `outputDir`) → the packet dir is declared
 *   (a gone dir becomes a NAMED gap at the service's existence filter);
 * - marker present but unparseable/invalid → the marker file ITSELF is
 *   declared with an honest invalid label — named, never fabricated;
 * - no marker → no packet leg (the rest of the chain stands alone).
 */
function restorePacketLeg(seatRef: string, openrigHome: string): Array<{ address: string; label: string }> {
  // Same sanitization the precompact hook applies when writing the marker key.
  const key = seatRef.replace(/[^a-zA-Z0-9_.@-]/g, "_");
  const markerPath = join(openrigHome, "compaction", "restore-pending", `${key}.json`);
  if (!existsSync(markerPath)) return [];
  let marker: { outputDir?: unknown; createdAt?: unknown };
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return [{ address: markerPath, label: "restore-pending marker present but INVALID (unparseable) — packet address unavailable; inspect the marker itself" }];
  }
  const outputDir = typeof marker.outputDir === "string" ? marker.outputDir.trim() : "";
  if (!outputDir) {
    return [{ address: markerPath, label: "restore-pending marker present but INVALID (no packet address) — inspect the marker itself" }];
  }
  const createdAt = typeof marker.createdAt === "string" ? ` (marker created ${marker.createdAt})` : "";
  return [{ address: outputDir, label: `latest restore packet from the compaction seam${createdAt}` }];
}
