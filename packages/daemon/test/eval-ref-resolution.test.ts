import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCase } from "./helpers/eval-grader.js";
import { resolveCaseRefs, unresolvedCases, buildProductionPackage } from "./helpers/eval-ref-resolution.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

// slice-07 re-review HIGH-1 — the shared validator resolves PER CASE against a given production
// package dir, so a case with no/absent/non-canonical ref fails BY NAME. A tiny fake production dir
// suffices for the pure validator; it is cleaned in afterAll (re-review MEDIUM-2: no temp leak).
const prod = mkdtempSync(join(tmpdir(), "eval-ref-res-"));
afterAll(() => rmSync(prod, { recursive: true, force: true }));
mkdirSync(join(prod, "skills/core/known"), { recursive: true });
writeFileSync(join(prod, "skills/core/known/manifest.yaml"), 'name: known\nversion: "1"\ntaxonomy: skills\nfiles: []\n');

const CASES: EvalCase[] = [
  { id: "good", name: "x", category: "selection", prompt: "p", expectedPatterns: ["rig context get\\s+skills/core/known"] },
  { id: "bad-absent", name: "x", category: "selection", prompt: "p", expectedPatterns: ["rig context get\\s+skills/core/absent"] },
  { id: "bad-bare", name: "x", category: "selection", prompt: "p", expectedPatterns: ["rig context get\\s+core/known"] },
  { id: "bad-noref", name: "x", category: "selection", prompt: "p", expectedPatterns: ["do the thing"] },
  // slice-05 Q3 behavior case — asserts observable behavior, NO context-pull contract, so it must
  // never be refused by the production-ref preflight (re-review restack HIGH-1).
  { id: "behavior-observable", name: "x", category: "behavior", prompt: "p", expectedPatterns: ["rig context (get|profile)"] },
];

describe("eval-ref-resolution — per-case, by name", () => {
  const res = resolveCaseRefs(CASES, prod);

  it("yields exactly one resolution per case", () => {
    expect(res).toHaveLength(CASES.length);
  });

  it("resolves a present canonical ref", () => {
    expect(res.find((r) => r.caseId === "good")?.resolved).toBe(true);
  });

  it("flags only the SELECTION/LOADING cases (absent / bare / no-ref) — never the behavior case", () => {
    // The behavior case has no context-pull contract, so it is NOT among the refused cases.
    expect(unresolvedCases(res).map((r) => r.caseId).sort()).toEqual(["bad-absent", "bad-bare", "bad-noref"]);
    expect(res.find((r) => r.caseId === "bad-noref")?.ref).toBeNull();
    expect(res.find((r) => r.caseId === "bad-bare")?.canonical).toBe(false);
  });

  it("does NOT refuse a behavior case — it has no context-pull contract (re-review restack HIGH-1)", () => {
    const behavior = res.find((r) => r.caseId === "behavior-observable");
    expect(behavior?.requiresRef).toBe(false);
    // run-evals.mjs refuses the whole run iff `unresolvedCases(resolveCaseRefs(...))` is non-empty
    // (the entry's exit-2 preflight). Pinning that composition on a MIXED selection+behavior set proves
    // the entry can never refuse a valid behavior case, while genuinely-broken selection cases still do.
    const refused = unresolvedCases(res);
    expect(refused.map((r) => r.caseId)).not.toContain("behavior-observable");
    expect(refused.every((r) => r.requiresRef)).toBe(true);
  });
});

describe("buildProductionPackage — cleans up its temp package (re-review MEDIUM-2)", () => {
  it("cleanup() removes the built temp dir (no leak after success)", () => {
    const built = buildProductionPackage(REPO);
    expect(existsSync(built.dir)).toBe(true);
    built.cleanup();
    expect(existsSync(built.dir)).toBe(false);
  });
});
