import { describe, it, expect } from "vitest";
import { classifyResourceProjection, hashContent } from "../src/domain/conflict-detector.js";

// Content fixtures. source is the NEW content to project; targets vary.
const files: Record<string, string> = {
  src: "SOURCE-NEW-v2",
  tgt_stale: "PROJECTED-OLD-v1", // == what we last wrote → stale-projection
  tgt_operator: "OPERATOR-EDIT", // diverged from both last-write and source
  tgt_same: "SOURCE-NEW-v2", // == source → no_op
};
const fsOps = { exists: (p: string) => p in files, readFile: (p: string) => files[p]! };

describe("classifyResourceProjection — P20 discrimination (manifest consult)", () => {
  it("target absent → safe_projection", () => {
    expect(classifyResourceProjection("src", "MISSING", "skill", undefined, fsOps, () => null)).toBe("safe_projection");
  });

  it("source == target → no_op (already current)", () => {
    expect(classifyResourceProjection("src", "tgt_same", "skill", undefined, fsOps, () => hashContent(files.tgt_same!))).toBe("no_op");
  });

  it("STALE: target == last-projected (source advanced) → stale_overwrite (safe, silent)", () => {
    const last = hashContent(files.tgt_stale!); // manifest says we wrote exactly this
    expect(classifyResourceProjection("src", "tgt_stale", "skill", undefined, fsOps, () => last)).toBe("stale_overwrite");
  });

  it("OPERATOR: target diverges from BOTH last-write and source → operator_conflict (protect)", () => {
    const last = hashContent("WHAT-WE-WROTE-EARLIER"); // ≠ current target (operator edited it)
    expect(classifyResourceProjection("src", "tgt_operator", "skill", undefined, fsOps, () => last)).toBe("operator_conflict");
  });

  it("NO manifest entry → hash_conflict (the P17 fallback)", () => {
    expect(classifyResourceProjection("src", "tgt_operator", "skill", undefined, fsOps, () => null)).toBe("hash_conflict");
  });

  it("legacy caller (no lookup arg) → hash_conflict (P17 behavior unchanged)", () => {
    expect(classifyResourceProjection("src", "tgt_operator", "skill", undefined, fsOps)).toBe("hash_conflict");
  });

  // BROKEN vs ABSENT (review-r1 MEDIUM). A manifest read that THREW is BROKEN: we
  // cannot rule out an operator edit, and hash_conflict WOULD overwrite it. True
  // fail-closed = PROTECT (operator_conflict). This is distinct from ABSENT (null,
  // no entry) which is the benign P17 hash_conflict fallback (pinned just below).
  it("manifest lookup THROWS (broken read) → operator_conflict (true fail-closed: PROTECT, never overwrite)", () => {
    const throwing = () => {
      throw new Error("db locked");
    };
    expect(classifyResourceProjection("src", "tgt_operator", "skill", undefined, fsOps, throwing)).toBe("operator_conflict");
  });

  it("BROKEN≠ABSENT: a returned null (no entry) stays hash_conflict, only a THROW protects", () => {
    // guards the split — regression here would either re-conflate the two or over-protect absent targets.
    expect(classifyResourceProjection("src", "tgt_operator", "skill", undefined, fsOps, () => null)).toBe("hash_conflict");
    expect(classifyResourceProjection("src", "tgt_operator", "skill", undefined, fsOps, () => { throw new Error("x"); })).toBe("operator_conflict");
  });
});
