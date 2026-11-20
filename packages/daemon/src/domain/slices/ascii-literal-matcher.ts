// One-pass multi-literal matcher (Aho-Corasick over ASCII) for the slice
// indexer's fallback membership scan.
//
// The fallback scan asks, for every queue row, which slice terms occur in its
// body or tags under SQLite LIKE '%term%' semantics: ASCII-only case folding,
// and the haystack ends at its first U+0000. A term without LIKE wildcards
// (`%`, `_`), without U+0000 and made only of ASCII is a plain case-folded
// substring test, which this matcher answers for ALL such terms in one pass
// over the haystack, without folding or copying it. Terms outside that class
// keep the translated-LIKE regex path in the caller.
//
// Why: the previous prefilter was one RegExp alternating every term, whose
// cost per row grew with the number of terms. This is one transition pass over
// the haystack plus a visit per matched output (every term ending at that
// position, including terms already marked for the row: nested terms such as
// `a`, `aa`, `aaa` over a long run of `a` cost more per character as terms are
// added); the caller then does per-term work on the rows that match.
//
// Size: the finished transition table is dense, 128 Int32 entries (512 bytes)
// per trie state, and there is at most one state per character of the terms:
// ~800 terms of ~20 characters cost a few MB, 10k such terms about 100 MB, for
// the duration of one index build. That is the table only: construction also
// holds a Map of children and an output list per state until it finishes, so
// the peak is higher. A compressed alphabet (only the characters the terms
// use) would shrink the dense table if the number of terms grows.

const ALPHABET = 128;

/** Lowercase ASCII A-Z only, the fold SQLite LIKE applies. */
function foldAscii(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

export class AsciiLiteralMatcher {
  /** True when `term` is answered exactly by this matcher: non-empty, ASCII
   *  only, and free of the LIKE wildcards `%`/`_` and of U+0000. */
  static eligible(term: string): boolean {
    if (term.length === 0) return false;
    for (let i = 0; i < term.length; i++) {
      const c = term.charCodeAt(i);
      if (c === 0 || c >= ALPHABET || c === 37 /* % */ || c === 95 /* _ */) return false;
    }
    return true;
  }

  readonly size: number;
  private readonly delta: Int32Array;
  private readonly outStart: Int32Array;
  private readonly outIds: Int32Array;

  /** `terms[i]` is reported as id `i`. Every term must be `eligible`. Terms
   *  that are equal after folding (`Foo`, `foo`) are each reported. */
  constructor(terms: readonly string[]) {
    this.size = terms.length;
    const children: Array<Map<number, number>> = [new Map()];
    const own: number[][] = [[]];
    terms.forEach((term, id) => {
      if (!AsciiLiteralMatcher.eligible(term)) {
        throw new Error(`AsciiLiteralMatcher: term ${JSON.stringify(term)} is not a plain ASCII literal`);
      }
      let state = 0;
      for (let i = 0; i < term.length; i++) {
        const c = foldAscii(term.charCodeAt(i));
        let next = children[state]!.get(c);
        if (next === undefined) {
          next = children.length;
          children.push(new Map());
          own.push([]);
          children[state]!.set(c, next);
        }
        state = next;
      }
      own[state]!.push(id);
    });

    const states = children.length;
    const delta = new Int32Array(states * ALPHABET);
    const fail = new Int32Array(states);
    const out: number[][] = own.map((ids) => ids.slice());
    // Breadth-first: a state's failure target is always shallower, so its
    // transitions and outputs are complete before the state reads them.
    const queue: number[] = [];
    for (let c = 0; c < ALPHABET; c++) {
      const next = children[0]!.get(c);
      if (next !== undefined) {
        delta[c] = next;
        fail[next] = 0;
        queue.push(next);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const state = queue[head]!;
      const f = fail[state]!;
      if (out[f]!.length > 0) out[state] = out[state]!.concat(out[f]!);
      const base = state * ALPHABET;
      for (let c = 0; c < ALPHABET; c++) {
        const next = children[state]!.get(c);
        if (next !== undefined) {
          delta[base + c] = next;
          fail[next] = delta[f * ALPHABET + c]!;
          queue.push(next);
        } else {
          delta[base + c] = delta[f * ALPHABET + c]!;
        }
      }
    }

    const outStart = new Int32Array(states + 1);
    for (let s = 0; s < states; s++) outStart[s + 1] = outStart[s]! + out[s]!.length;
    const outIds = new Int32Array(outStart[states]!);
    for (let s = 0; s < states; s++) outIds.set(out[s]!, outStart[s]!);
    this.delta = delta;
    this.outStart = outStart;
    this.outIds = outIds;
  }

  /** Sets `marks[id] = stamp` for every term occurring in `haystack` before its
   *  first U+0000, ASCII-case-insensitively. Returns true when any term matched.
   *  A non-ASCII code unit resets the scan: no eligible term contains one. */
  scan(haystack: string, marks: Uint32Array, stamp: number): boolean {
    const { delta, outStart, outIds } = this;
    let state = 0;
    let found = false;
    for (let i = 0; i < haystack.length; i++) {
      let c = haystack.charCodeAt(i);
      if (c === 0) break;
      if (c >= ALPHABET) {
        state = 0;
        continue;
      }
      if (c >= 65 && c <= 90) c += 32;
      state = delta[state * ALPHABET + c]!;
      const from = outStart[state]!;
      const to = outStart[state + 1]!;
      if (from !== to) {
        found = true;
        for (let k = from; k < to; k++) marks[outIds[k]!] = stamp;
      }
    }
    return found;
  }
}
