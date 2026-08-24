import { describe, it, expect, afterAll } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalCasesFromDir } from "./helpers/eval-cases.js";
import {
  resolveCaseRefs,
  unresolvedCases,
  buildProductionPackage,
} from "./helpers/eval-ref-resolution.js";

// slice-07 Repairs 1+2 re-review (HIGH-1) — HERMETIC: build the EXACT production package into a temp
// dir (never read the gitignored packages/daemon/context-packs residue), and assert PER CASE that
// every case yields a canonical ref that resolves in the built package. Fixture-vs-production drift —
// or a case with no canonical ref — fails structurally, by name. (Requires the daemon built: the
// generator validates through the compiled manifest parser.)
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CASES_DIR = resolve(HERE, "..", "..", "test-system", "evals", "cases");

describe("REPAIR (re-review HIGH-1) — refs resolve in a freshly-built production package", () => {
  const { cases } = loadEvalCasesFromDir(CASES_DIR);
  const built = buildProductionPackage(REPO);
  afterAll(built.cleanup);
  const resolutions = resolveCaseRefs(cases, built.dir);

  it("yields a canonical ref for EVERY ref-bearing case (per-case, not a suite-wide count)", () => {
    expect(resolutions).toHaveLength(cases.length);
    // Only selection/loading cases contract to pull context; a behavior case (slice-05 Q3) carries
    // no ref and is exempt — enforce canonicality exactly where the contract requires it.
    const bad = resolutions.filter((r) => r.requiresRef && (r.ref === null || !r.canonical)).map((r) => r.caseId);
    expect(bad).toEqual([]);
  });

  it("every case ref resolves in the built production package", () => {
    const missing = unresolvedCases(resolutions).map((r) => `${r.caseId}:${r.ref ?? "<none>"}`);
    expect(missing).toEqual([]);
  });
});
