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
writeFileSync(join(prod, "skills/core/known/manifest.yaml"), 'name: known\nversion: "1"\nfiles: []\n');

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

  it("flags absent / bare (non-canonical) / no-ref cases — each by caseId", () => {
    expect(unresolvedCases(res).map((r) => r.caseId).sort()).toEqual(["bad-absent", "bad-bare", "bad-noref"]);
    expect(res.find((r) => r.caseId === "bad-noref")?.ref).toBeNull();
    expect(res.find((r) => r.caseId === "bad-bare")?.canonical).toBe(false);
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
