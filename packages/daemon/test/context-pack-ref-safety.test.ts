// Slice-03 rig-context v1 (OPR.0.5.0.3) — ref hardening (proof item 6 + R2 closure item 8).
// The addressing contract §2 calls "the ONE thing that must be right": PATH-LIKE MULTI-SEGMENT
// refs (e.g. `packs/compaction-restore`) with PER-SEGMENT validation (salvaged assertSafePackName
// charset, bent per `/`-segment, still banning traversal/absolute/empty/injection), and the
// bounded delimiter-free version token isSafePackVersion (salvaged verbatim from checkpoint
// b10c1618 — fixes R2 (a) ENAMETOOLONG + the store-id half of (b)).

import { describe, it, expect } from "vitest";
import { isSafePackRef, assertSafePackRef, isSafePackVersion } from "../src/domain/context-packs/ref-safety.js";

describe("isSafePackRef — path-like multi-segment ref validation (per-segment)", () => {
  it("accepts a path-like multi-segment ref (each segment on the salvaged charset)", () => {
    expect(isSafePackRef("packs/compaction-restore")).toBe(true);
    expect(isSafePackRef("compaction-restore")).toBe(true); // single segment still valid
    expect(isSafePackRef("a/b/c.d_e-f")).toBe(true);
  });

  for (const bad of [
    "../evil",                 // parent-traversal segment
    "packs/../evil",           // traversal mid-ref
    "packs/..",                // trailing ..
    "/abs/path",               // absolute → empty leading segment
    "packs//nested",           // empty interior segment
    "packs/",                  // empty trailing segment
    "",                        // empty ref
    ".",                       // dot segment
    "packs/.hidden",           // segment not starting on the leading charset
    "packs/na me",             // whitespace (injection surface)
    "packs/na:me",             // colon (YAML/id injection)
    "packs/na\nme",            // newline (YAML injection)
    "packs/na\tme",            // tab
    `packs/${"x".repeat(65)}`, // segment over the 64-char component cap
  ]) {
    it(`rejects unsafe ref ${JSON.stringify(bad)}`, () => {
      expect(isSafePackRef(bad)).toBe(false);
      expect(() => assertSafePackRef(bad)).toThrow();
    });
  }

  it("assertSafePackRef is a no-op (no throw) for a valid ref", () => {
    expect(() => assertSafePackRef("packs/compaction-restore")).not.toThrow();
  });
});

describe("isSafePackVersion — bounded delimiter-free version token (salvaged; R2 (a)/(b) fix)", () => {
  it("accepts a bounded version token", () => {
    expect(isSafePackVersion("1.0.0")).toBe(true);
    expect(isSafePackVersion("2026-08-04")).toBe(true);
    expect(isSafePackVersion("v1_2+build")).toBe(true);
  });

  for (const bad of [
    "x".repeat(300),   // R2 (a): a 300-char version → ENAMETOOLONG on `${name}-${version}.md`
    "1.0 0",           // whitespace
    "1:0:0",           // colon → store-id collision (R2 (b))
    "1/0",             // separator
    "@1.0",            // leading non-charset / @
    "",                // empty
  ]) {
    it(`rejects unsafe version ${JSON.stringify(bad.length > 20 ? bad.slice(0, 12) + "…" : bad)}`, () => {
      expect(isSafePackVersion(bad)).toBe(false);
    });
  }
});
