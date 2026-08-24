// OPR.0.5.3.5 mini-req 6 — ADDRESSABLE MARKDOWN, the resolver core.
//
// Locked conventions (SPEC.md Q1 ruling, approved-spec-by review-r1; grammar authority
// FOUNDER_NOTES.md P1): an address is `name#H2-slug/H3-slug` — exactly ONE form, held in
// memory. `name` is resolved by the caller (library index or configured tree roots — the
// Q2-Amendment 1 one-grammar-two-resolvers ruling); everything after `#` resolves HERE,
// against markdown text. A bare address returns the section's FULL span: everything until
// the next SAME-OR-HIGHER-level header, children included. The section's OWN text (until
// the next header of ANY level) is the `ownText` field of the same resolution — a field,
// never a second address syntax (the superseded May design accepted two separator forms;
// we deliberately ship one). Headers inside code fences are never addresses and never
// terminate spans (the May prototype's proven trap). Resolution FAILS LOUD: an address
// that matches nothing is an AddressResolutionError naming the reason and the real
// candidates — never a silent empty; in an install pipeline a missing atom must stop the
// compose, not thin the walk quietly (the prototype's graceful-undefined is the one
// behavior explicitly not carried).
//
// This module is PURE (text in, spans out) and daemon-homed so the CLI (which depends on
// @openrig/daemon) and the daemon assembler share one resolver — one grammar, one home.
// Scope fence (Q4): resolution + composition support only; CRUD/surgical-edit/lint stays
// with the 0.6.0 mdar-full-ship trail.

/** Addressable depth per the Q1 ruling: H2 and H3. */
const MIN_LEVEL = 2;
const MAX_LEVEL = 3;

export class AddressResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressResolutionError";
  }
}

/** ONE slug rule, simple enough to hold in memory: lowercase; markdown emphasis/code
 *  markers stripped with the text kept; every run of non-alphanumerics becomes one
 *  hyphen; leading/trailing hyphens trimmed. */
export function slugifyHeader(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ParsedAddress {
  /** The pre-`#` ref — a library ref or a tree path; the caller's resolver owns it. */
  ref: string;
  /** 0 (whole file), 1 (H2) or 2 (H2/H3) slugs. */
  headerPath: string[];
}

/** Parse the one grammar form `ref` / `ref#h2` / `ref#h2/h3`. Fail-loud on anything else. */
export function parseAddress(address: string): ParsedAddress {
  const hashCount = (address.match(/#/g) ?? []).length;
  if (hashCount > 1) {
    throw new AddressResolutionError(
      `address '${address}' has ${hashCount} '#' separators — the one form is name#H2-slug/H3-slug (a single '#').`,
    );
  }
  const [ref, headerPart] = hashCount === 1 ? (address.split("#") as [string, string]) : [address, undefined];
  if (!ref) {
    throw new AddressResolutionError(`address '${address}' has an empty ref before '#' — an address always names its file/ref.`);
  }
  if (headerPart === undefined) return { ref, headerPath: [] };
  const headerPath = headerPart.split("/");
  if (headerPath.some((seg) => seg.length === 0)) {
    throw new AddressResolutionError(`address '${address}' has an empty header segment — the form is name#H2-slug or name#H2-slug/H3-slug.`);
  }
  if (headerPath.length > MAX_LEVEL - MIN_LEVEL + 1) {
    throw new AddressResolutionError(
      `address '${address}' goes ${headerPath.length} levels deep — addresses target H2 and H3 only (Q1 ruling), so the deepest form is name#H2-slug/H3-slug.`,
    );
  }
  return { ref, headerPath };
}

export interface MarkdownSection {
  /** Header level (2 or 3). */
  level: number;
  /** The header's raw title text. */
  title: string;
  /** This section's address path: [h2Slug] or [h2Slug, h3Slug]. */
  headerPath: string[];
  /** 0-based line of the header itself. */
  headerLine: number;
  /** FULL span (Q1): header line through the line before the next same-or-higher header. */
  text: string;
  /** OWN text: header line through the line before the next header of ANY level. */
  ownText: string;
}

interface HeaderHit {
  level: number;
  title: string;
  line: number;
}

interface HeaderScan {
  hits: HeaderHit[];
  /** Set when EOF arrives inside an open fence (r1 F1): every header after the
   *  opener has been swallowed — the validator must name it, or a file that
   *  loses most of its sections to one stray fence passes the gate clean. */
  unterminatedFenceLine: number | null;
}

/** Scan for real headers, skipping fenced code blocks (``` or ~~~, any info string;
 *  a fence closes only on the same marker at the same or greater length). */
function scanHeaders(lines: string[]): HeaderScan {
  const hits: HeaderHit[] = [];
  let fence: { marker: string; length: number; line: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      const length = fenceMatch[1]!.length;
      if (!fence) {
        fence = { marker, length, line: i };
      } else if (fence.marker === marker && length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;
    const header = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (header) hits.push({ level: header[1]!.length, title: header[2]!, line: i });
  }
  return { hits, unterminatedFenceLine: fence?.line ?? null };
}

/** Parse the addressable H2/H3 section tree of a markdown text.
 *  A matched section is NEVER empty by construction: the span includes the header
 *  line itself, so even a body-less `## alpha` (next line another header, or EOF)
 *  resolves to at least its own header — a matched-but-empty section can never
 *  quietly thin a compose (the structural half of the fail-loud contract; r1 A2). */
export function parseMarkdownSections(text: string): MarkdownSection[] {
  const lines = text.split("\n");
  const { hits: headers } = scanHeaders(lines);
  const sections: MarkdownSection[] = [];
  let currentH2: string | null = null;
  for (let idx = 0; idx < headers.length; idx++) {
    const h = headers[idx]!;
    if (h.level < MIN_LEVEL || h.level > MAX_LEVEL) {
      if (h.level < MIN_LEVEL) currentH2 = null; // an H1 resets the H2 scope
      continue;
    }
    const slug = slugifyHeader(h.title);
    if (h.level === 2) currentH2 = slug;
    // r1 F2: test the SCOPE against null, never truthiness — an H2 whose title
    // slugifies to "" still owns its children. They stay under the empty segment
    // (unreachable by any legal address, and the validator names the family)
    // instead of being silently promoted to top-level addresses.
    const headerPath = h.level === 2 ? [slug] : currentH2 !== null ? [currentH2, slug] : [slug];
    // FULL span: to the next header with level <= this one (same-or-higher).
    const fullEnd = headers.slice(idx + 1).find((n) => n.level <= h.level)?.line ?? lines.length;
    // OWN text: to the next header of ANY level.
    const ownEnd = headers[idx + 1]?.line ?? lines.length;
    sections.push({
      level: h.level,
      title: h.title,
      headerPath,
      headerLine: h.line,
      text: lines.slice(h.line, fullEnd).join("\n"),
      ownText: lines.slice(h.line, ownEnd).join("\n"),
    });
  }
  return sections;
}

/** Resolve a header path against markdown text. FAIL-LOUD: no match is an error that
 *  names the miss and the real candidates at that altitude — never a silent empty. */
export function resolveAddress(text: string, headerPath: string[]): MarkdownSection {
  if (headerPath.length === 0) {
    throw new AddressResolutionError("resolveAddress needs at least one header slug; a bare ref resolves to the whole file at the caller.");
  }
  const sections = parseMarkdownSections(text);
  const wanted = headerPath.join("/");
  const hits = sections.filter((s) => s.headerPath.join("/") === wanted);
  // AMBIGUITY fails loud at RESOLVE time (Atom 4c): a duplicate header-path is
  // a validator finding, but serving must not depend on the validator having
  // run — first-match on a shipped duplicate is a silent wrong answer.
  if (hits.length > 1) {
    throw new AddressResolutionError(
      `address '#${wanted}' is AMBIGUOUS in this file — ${hits.length} sections share the path ` +
        `(header lines ${hits.map((h) => h.headerLine).join(", ")}). Fix the duplicate headers; ` +
        `serving any one of them would be a silent wrong answer.`,
    );
  }
  if (hits.length === 1) return hits[0]!;
  const parentPath = headerPath.slice(0, -1).join("/");
  const candidates = sections
    .filter((s) => s.headerPath.slice(0, -1).join("/") === parentPath)
    .map((s) => s.headerPath.join("/"));
  throw new AddressResolutionError(
    `address '#${wanted}' matches no header in this file — composition stops here rather than thinning the walk. ` +
      (candidates.length > 0
        ? `Addressable sections under '${parentPath || "(top)"}': ${candidates.join(", ")}.`
        : `The file has ${sections.length} addressable section(s): ${sections.map((s) => s.headerPath.join("/")).join(", ") || "(none)"}.`),
  );
}

export type AddressabilityFinding =
  | { kind: "duplicate-header-path"; headerPath: string; lines: number[] }
  | { kind: "unaddressable-header"; headerPath: string; line: number; title: string }
  | { kind: "unterminated-fence"; line: number };

/** The compose-gate validator: every H2/H3 must be uniquely addressable under the one
 *  slug rule, and the file must not silently lose sections. Findings, not throws —
 *  the caller decides the gate. */
export function validateMarkdownAddressability(text: string): AddressabilityFinding[] {
  const lines = text.split("\n");
  const { unterminatedFenceLine } = scanHeaders(lines);
  const sections = parseMarkdownSections(text);
  const findings: AddressabilityFinding[] = [];
  // r1 F1: an unclosed fence swallows every later header; resolution stays honest
  // (a swallowed address fails loud) but the GATE must name the loss up front —
  // this is the corpus defect a real file is most likely to actually contain.
  if (unterminatedFenceLine !== null) {
    findings.push({ kind: "unterminated-fence", line: unterminatedFenceLine });
  }
  const seen = new Map<string, number[]>();
  for (const s of sections) {
    // r1 F2 family rule: ANY empty segment makes a section unreachable by a legal
    // address (parseAddress rejects empty segments) — flag parent AND children.
    if (s.headerPath.some((segment) => segment.length === 0)) {
      findings.push({ kind: "unaddressable-header", headerPath: s.headerPath.join("/"), line: s.headerLine, title: s.title });
      continue;
    }
    const key = s.headerPath.join("/");
    seen.set(key, [...(seen.get(key) ?? []), s.headerLine]);
  }
  for (const [headerPath, lineNumbers] of seen) {
    if (lineNumbers.length > 1) findings.push({ kind: "duplicate-header-path", headerPath, lines: lineNumbers });
  }
  return findings;
}
