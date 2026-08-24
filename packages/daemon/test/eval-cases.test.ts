import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalCasesFromDir } from "./helpers/eval-cases.js";

// slice-07 R6 — conformance guard: the authored case set validates through the schema and covers
// both categories. A guard (not a logic RED-first) — it protects the authored data from drift.
const HERE = dirname(fileURLToPath(import.meta.url));
// packages/daemon/test -> packages/test-system/evals/cases
const CASES_DIR = resolve(HERE, "..", "..", "test-system", "evals", "cases");

describe("eval cases — authored set conforms", () => {
  const { cases, errors } = loadEvalCasesFromDir(CASES_DIR);

  it("every authored case validates through the schema", () => {
    expect(errors).toEqual([]);
  });

  it("covers selection and loading", () => {
    const selection = cases.filter((c) => c.category === "selection");
    const loading = cases.filter((c) => c.category === "loading");
    expect(selection.length).toBeGreaterThanOrEqual(10);
    expect(loading.length).toBeGreaterThanOrEqual(4);
  });

  it("case ids are unique", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every loading case carries a get-before-action order", () => {
    const loadingWithoutOrder = cases.filter((c) => c.category === "loading" && !c.order);
    expect(loadingWithoutOrder).toEqual([]);
  });
});
