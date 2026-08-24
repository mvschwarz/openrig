import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase } from "./helpers/eval-grader.js";
import { resolveCaseRefs, unresolvedCases } from "./helpers/eval-ref-resolution.js";

// slice-07 re-review HIGH-1 — the shared validator resolves PER CASE against a given production
// package dir, so a case with no canonical ref, or an absent ref, fails BY NAME (never disappears).
const prod = mkdtempSync(join(tmpdir(), "eval-ref-res-"));
mkdirSync(join(prod, "skills/core/known"), { recursive: true });
writeFileSync(join(prod, "skills/core/known/manifest.yaml"), "name: known\nversion: \"1\"\nfiles: []\n");

const CASES: EvalCase[] = [
  { id: "good", name: "x", category: "selection", prompt: "p", expectedPatterns: ["rig context get\\s+skills/core/known"] },
  { id: "bad-absent", name: "x", category: "selection", prompt: "p", expectedPatterns: ["rig context get\\s+skills/core/absent"] },
  { id: "bad-bare", name: "x", category: "selection", prompt: "p", expectedPatterns: ["rig context get\\s+core/known"] },
  { id: "bad-noref", name: "x", category: "selection", prompt: "p", expectedPatterns: ["do the thing"] },
];

describe("eval-ref-resolution — per-case, by name", () => {
  const res = resolveCaseRefs(CASES, prod);

  it("yields exactly one resolution per case", () => {
    expect(res).toHaveLength(CASES.length);
  });

  it("resolves a present canonical ref", () => {
    expect(res.find((r) => r.caseId === "good")?.resolved).toBe(true);
  });

  it("flags an absent ref, a bare (non-canonical) ref, and a no-ref case — each by caseId", () => {
    const bad = unresolvedCases(res).map((r) => r.caseId).sort();
    expect(bad).toEqual(["bad-absent", "bad-bare", "bad-noref"]);
    expect(res.find((r) => r.caseId === "bad-noref")?.ref).toBeNull();
    expect(res.find((r) => r.caseId === "bad-bare")?.canonical).toBe(false);
  });
});
