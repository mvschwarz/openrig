import { describe, it, expect } from "vitest";
import { AsciiLiteralMatcher } from "../src/domain/slices/ascii-literal-matcher.js";

// The reference: SQLite LIKE '%term%' for a wildcard-free ASCII term, the way
// the slice indexer's regex path evaluates it (ASCII fold, haystack cut at the
// first U+0000, literal contains).
function likeContains(haystack: string, term: string): boolean {
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  const nul = haystack.indexOf("\u0000");
  const visible = nul === -1 ? haystack : haystack.slice(0, nul);
  return fold(visible).includes(fold(term));
}

function matched(matcher: AsciiLiteralMatcher, haystack: string): number[] {
  const marks = new Uint32Array(matcher.size);
  matcher.scan(haystack, marks, 1);
  return [...marks.keys()].filter((id) => marks[id] === 1);
}

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("AsciiLiteralMatcher", () => {
  it("accepts only non-empty ASCII terms without LIKE wildcards or U+0000", () => {
    expect(AsciiLiteralMatcher.eligible("01-slice-name")).toBe(true);
    expect(AsciiLiteralMatcher.eligible("Mixed-CASE.1")).toBe(true);
    expect(AsciiLiteralMatcher.eligible("re.+?^${}()|[x]\\z")).toBe(true);
    for (const term of ["", "a%b", "a_b", "a\u0000b", "café", "\u{1F600}", "\u007f\u0080"]) {
      expect(AsciiLiteralMatcher.eligible(term)).toBe(false);
    }
    expect(() => new AsciiLiteralMatcher(["ok", "a_b"])).toThrow(/plain ASCII literal/);
  });

  it("reports every term that occurs, including terms nested in or overlapping others", () => {
    const terms = ["mission-a", "a", "sion-a-s1", "s1", "mission-a-s1", "absent"];
    const matcher = new AsciiLiteralMatcher(terms);
    const hay = "work on MISSION-A-S1 today";
    expect(matched(matcher, hay).map((id) => terms[id])).toEqual(
      terms.filter((term) => likeContains(hay, term)),
    );
  });

  it("reports the classic overlapping set (she, he, hers, his) found through failure links", () => {
    const terms = ["he", "she", "his", "hers"];
    const matcher = new AsciiLiteralMatcher(terms);
    expect(matched(matcher, "USHERS").map((id) => terms[id])).toEqual(["he", "she", "hers"]);
    expect(matched(matcher, "this").map((id) => terms[id])).toEqual(["his"]);
  });

  it("reports each of several terms that are equal after ASCII folding", () => {
    const terms = ["Foo", "foo", "FOO", "fo"];
    const matcher = new AsciiLiteralMatcher(terms);
    expect(matched(matcher, "xfOox")).toEqual([0, 1, 2, 3]);
    expect(matched(matcher, "xfx")).toEqual([]);
  });

  it("folds only ASCII letters and stops at the first U+0000", () => {
    const matcher = new AsciiLiteralMatcher(["abc", "tail"]);
    expect(matched(matcher, "xxABCxx")).toEqual([0]);
    expect(matched(matcher, "abc\u0000tail")).toEqual([0]);
    expect(matched(matcher, "\u0000abc")).toEqual([]);
    expect(matched(matcher, "aébc")).toEqual([]);
    expect(matched(matcher, "ÉABC")).toEqual([0]);
    expect(matched(matcher, "ab\u{1F600}c")).toEqual([]);

    // Unicode case mappings that land on ASCII (the Kelvin sign K, dotted
    // capital I) and the neighbours of A-Z/a-z (@, `) never fold.
    const edges = new AsciiLiteralMatcher(["kit", "x@y", "x`y"]);
    expect(matched(edges, "KIT")).toEqual([]);
    expect(matched(edges, "KIT")).toEqual([0]);
    expect(matched(edges, "X@Y")).toEqual([1]);
    expect(matched(edges, "X`Y")).toEqual([2]);
    expect(matched(new AsciiLiteralMatcher(["i"]), "İ")).toEqual([]);
  });

  it("leaves marks of other stamps alone and says whether anything matched", () => {
    const matcher = new AsciiLiteralMatcher(["x", "y"]);
    const marks = new Uint32Array(2);
    expect(matcher.scan("x", marks, 7)).toBe(true);
    expect(matcher.scan("zzz", marks, 8)).toBe(false);
    expect([...marks]).toEqual([7, 0]);
  });

  it("answers nothing, without failing, when built with no terms", () => {
    const matcher = new AsciiLiteralMatcher([]);
    expect(matcher.size).toBe(0);
    expect(matcher.scan("anything", new Uint32Array(0), 1)).toBe(false);
  });

  it("agrees with LIKE contains on randomized terms and haystacks", () => {
    const rand = prng(9894);
    const alphabet = "abAB-1.@`é\u0000 K\u{1F600}";
    const pick = (n: number, chars: string) => {
      const points = [...chars];
      return Array.from({ length: n }, () => points[Math.floor(rand() * points.length)]).join("");
    };
    for (let round = 0; round < 300; round++) {
      const terms = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 12) }, () => pick(1 + Math.floor(rand() * 4), "abkAB-1.@`")))];
      const matcher = new AsciiLiteralMatcher(terms);
      for (let h = 0; h < 10; h++) {
        const hay = pick(Math.floor(rand() * 40), alphabet);
        expect(matched(matcher, hay).map((id) => terms[id])).toEqual(terms.filter((term) => likeContains(hay, term)));
      }
    }
  });
});
