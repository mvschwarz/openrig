import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalCasesFromDir } from "./helpers/eval-cases.js";

// slice-07 REPAIR 2 — RED-first: every ref an eval case pulls must be a CANONICAL full-path ref
// (skills/<ns>/<name>, matching the on-disk library layout) AND must resolve in the EXACT production
// package. A bare ref (core/x) or a ref absent from production fails STRUCTURALLY, so fixture-vs-
// production drift can never pass silently. No alias layer; slash-containing refs are exact lookup.
const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = resolve(HERE, "..", "..", "test-system", "evals", "cases");
// packages/daemon/context-packs — the production package (build-package projects canon into it).
const PROD_PKG = resolve(HERE, "..", "context-packs");

/** Every ref a case pulls, from its expectedPatterns and (loading) its order.getPattern. */
function refsOfCase(c: { expectedPatterns: string[]; order?: { getPattern: string } }): string[] {
  const patterns = [...(c.expectedPatterns ?? [])];
  if (c.order?.getPattern) patterns.push(c.order.getPattern);
  const refs: string[] = [];
  for (const p of patterns) {
    const m = /rig context get\\s\+(\S+)/.exec(p);
    if (m) refs.push(m[1]!);
  }
  return refs;
}

describe("REPAIR 2 — eval refs are canonical and resolve against production", () => {
  const { cases } = loadEvalCasesFromDir(CASES_DIR);
  const refs = [...new Set(cases.flatMap(refsOfCase))];

  it("extracts a ref for every authored case", () => {
    expect(refs.length).toBeGreaterThanOrEqual(cases.length ? 1 : 0);
    expect(refs.length).toBeGreaterThan(0);
  });

  it("every ref is a canonical full-path ref (skills/<ns>/<name>)", () => {
    expect(refs.filter((r) => !r.startsWith("skills/"))).toEqual([]);
  });

  it("every ref resolves in the exact production package (drift fails structurally)", () => {
    const missing = refs.filter((r) => !existsSync(join(PROD_PKG, r, "manifest.yaml")));
    expect(missing).toEqual([]);
  });
});
