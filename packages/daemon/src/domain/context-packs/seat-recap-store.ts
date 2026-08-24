// OPR.0.5.3.5 mini-req 7 (Q2 + Q2-Amendment 1) — the seat recap store.
//
// The AUTHORED recap: decisions-with-rationale written by the outgoing occupant
// at the boundary, extending the shipped from-record boot recap's name (the Q2
// unify-what-exists ruling — predecessor-recap-resolver.ts remains the
// transcript-derived sibling). SEAT-HOMED beside LEARNED (Q2-Amendment 1(a):
// the recap is POSITION knowledge, unshareable by construction — a
// library-homed recap would be position knowledge on the portable shelf).
// RETENTION (1(b)): superseded-chain versioning — the newest recap is
// RECAP.md, predecessors stay byte-preserved under recap-superseded/ in the
// seat directory, cleaned by seat-directory lifecycle, NEVER by library
// curation; no librarian job is created.
//
// Two validation altitudes, deliberately different:
// - ADDRESSABILITY is the one HARD gate on write: the recap is composed by
//   address (seat:RECAP.md#...), so an unaddressable recap (duplicate header
//   paths, unterminated fence) would fail every handover profile downstream,
//   silently late. Structural, not prose-shaped.
// - The AUTHORING CONTRACT validates ADVISORY on its CHECKABLE subset only:
//   findings flag for review, never gate the boundary (the D2 pattern). The
//   contract's semantic halves (temporal order, derived-values-as-commands)
//   are not mechanically checkable and are NOT pretended at.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateMarkdownAddressability, parseMarkdownSections } from "../markdown-address.js";

export const RECAP_FILENAME = "RECAP.md";
const CHAIN_DIRNAME = "recap-superseded";

export class RecapWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecapWriteError";
  }
}

export interface RecapChainEntry {
  /** Absolute path of the superseded recap. */
  path: string;
  /** The supersession timestamp encoded in the filename (ms epoch). */
  supersededAtMs: number;
  /** Same-millisecond disambiguator (1 for the bare name, 2+ for -N suffixes). */
  sequence: number;
}

/** Write the seat's current recap, superseding any existing one into the
 *  chain. The gate is ADDRESSABILITY only — never prose shape. */
export function writeSeatRecap(opts: { seatDir: string; content: string; now?: () => number }): void {
  const findings = validateMarkdownAddressability(opts.content);
  if (findings.length > 0) {
    throw new RecapWriteError(
      `recap is not addressable and could never compose (seat:${RECAP_FILENAME}#... would fail every ` +
        `handover profile): ${findings.map((f) => f.kind === "unterminated-fence" ? `unterminated fence at line ${f.line}` : `${f.kind} '${"headerPath" in f ? f.headerPath : ""}'`).join("; ")}. ` +
        `Fix the structure (duplicate header paths / unterminated fences); prose shape is never gated.`,
    );
  }
  const now = opts.now ?? Date.now;
  const current = join(opts.seatDir, RECAP_FILENAME);
  if (existsSync(current)) {
    const chainDir = join(opts.seatDir, CHAIN_DIRNAME);
    mkdirSync(chainDir, { recursive: true });
    // COLLISION-SAFE naming (r1 F1): renameSync onto an existing path REPLACES
    // it, so two supersessions in one millisecond silently destroyed a
    // predecessor — the retention contract inverted. A counter suffix
    // disambiguates: nothing is lost AND the boundary write still succeeds
    // (better than throwing on both counts). `now` is injectable, so
    // programmatic callers collide deterministically, not rarely.
    const stamp = String(now()).padStart(15, "0");
    let target = join(chainDir, `RECAP-${stamp}.md`);
    for (let counter = 2; existsSync(target); counter++) {
      target = join(chainDir, `RECAP-${stamp}-${counter}.md`);
    }
    renameSync(current, target);
  }
  writeFileSync(current, opts.content);
}

/** The superseded chain, oldest first. Empty when no recap was ever superseded. */
export function listRecapChain(seatDir: string): RecapChainEntry[] {
  const chainDir = join(seatDir, CHAIN_DIRNAME);
  let names: string[];
  try {
    names = readdirSync(chainDir);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const m = name.match(/^RECAP-(\d+)(?:-(\d+))?\.md$/);
      return m
        ? { path: join(chainDir, name), supersededAtMs: Number(m[1]), sequence: m[2] ? Number(m[2]) : 1 }
        : null;
    })
    .filter((e): e is RecapChainEntry => e !== null)
    .sort((a, b) => a.supersededAtMs - b.supersededAtMs || a.sequence - b.sequence);
}

export type RecapContractFinding =
  | { kind: "no-decisions-section" }
  | { kind: "nonstandard-unverified-marker"; line: number };

/** The authoring contract's CHECKABLE subset (Q2): decisions-with-rationale has
 *  a structural proxy (a decisions-titled section exists); the UNVERIFIED
 *  marker has a canonical grammar (`UNVERIFIED:` uppercase) that must stay
 *  findable — a variant marker hides exactly the fact it exists to flag.
 *  Advisory: findings, never throws. */
export function validateRecapContract(content: string): RecapContractFinding[] {
  const findings: RecapContractFinding[] = [];
  const sections = parseMarkdownSections(content);
  const hasDecisions = sections.some((s) => s.headerPath[s.headerPath.length - 1]!.includes("decision"));
  if (!hasDecisions) findings.push({ kind: "no-decisions-section" });
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/unverified/i.test(line) && !line.includes("UNVERIFIED:")) {
      findings.push({ kind: "nonstandard-unverified-marker", line: i });
    }
  }
  return findings;
}
