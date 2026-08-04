// Slice-03 rig-context v1 (OPR.0.5.0.3) — the addressing-contract hardening (§2 "the ONE thing
// that must be right"). Salvaged from the frozen candidate (assertSafePackName @ 37972eb6,
// isSafePackVersion @ b10c1618) with the mandated BEND: refs are PATH-LIKE MULTI-SEGMENT, so the
// single-component name check becomes a PER-SEGMENT check over the same charset. This keeps every
// hardening property (no traversal, no absolute, no empty segment, no whitespace/YAML/id injection)
// while enabling `packs/compaction-restore`-style refs. The version token stays a bounded,
// delimiter-free single token (fixes R2 (a) ENAMETOOLONG + the store-id half of (b)).

// One safe path segment: the salvaged charset allowlist (leading alnum, then alnum/._-; ≤64 chars).
// The allowlist alone bans '/', whitespace, ':' , newlines, quotes — every traversal + YAML/id
// injection vector — and its leading-alnum rule rejects '.', '..' and dotfiles.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Bounded, delimiter-free version token — salvaged VERBATIM from checkpoint b10c1618
// (manifest-parser.ts). The ≤32-char cap keeps `${name}-${version}.md` well under the OS 255-byte
// filename limit, and the charset admits no separator that could forge a store id.
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

/**
 * A path-like pack ref is one or more `/`-separated segments, each a safe segment. Empty ref, an
 * absolute path (empty leading segment), a double/trailing slash (empty segment), a '.'/'..'
 * traversal segment, or any injection char in a segment → NOT safe.
 */
export function isSafePackRef(ref: string): boolean {
  if (ref.length === 0) return false;
  for (const segment of ref.split("/")) {
    if (segment.length === 0) return false; // absolute leading, interior '//', or trailing '/'
    if (segment === "." || segment === "..") return false; // defensive (SAFE_SEGMENT already bans them)
    if (!SAFE_SEGMENT.test(segment)) return false;
  }
  return true;
}

/** Throwing form for write/resolve sites — packs must stay inside the context store root. */
export function assertSafePackRef(ref: string): void {
  if (!isSafePackRef(ref)) {
    throw new Error(
      `unsafe pack ref '${ref}' — a ref must be one or more '/'-separated segments, each matching ` +
        `[A-Za-z0-9][A-Za-z0-9._-]{0,63} (no '.'/'..' , no absolute path, no empty segment, no ` +
        `whitespace or injection), so packs stay inside the context store root.`,
    );
  }
}

/** A pack version must be a single bounded token (no separators, whitespace, '@', or ':'). */
export function isSafePackVersion(version: string): boolean {
  return SAFE_VERSION.test(version);
}
