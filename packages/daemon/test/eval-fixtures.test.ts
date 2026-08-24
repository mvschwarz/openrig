import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";
import { loadEvalCasesFromDir } from "./helpers/eval-cases.js";

// slice-07 R6 — the seed fixture library must be valid packs the daemon can serve, AND must cover
// every ref the eval cases expect a seat to pull. Verifies through the daemon's OWN parseManifest
// (not a second parser) so a malformed fixture fails here, not at a live serve.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "..", "test-system", "evals", "fixtures");
const CASES_DIR = resolve(HERE, "..", "..", "test-system", "evals", "cases");

/** Every dir under fixtures/ that holds a manifest.yaml, as a ref (path relative to fixtures/). */
function fixtureRefs(): string[] {
  const refs: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = join(dir, entry.name);
      const ref = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (existsSync(join(abs, "manifest.yaml"))) refs.push(ref);
      else walk(abs, ref);
    }
  };
  walk(FIXTURES, "");
  return refs;
}

describe("eval seed fixtures — valid packs covering the case refs", () => {
  const refs = fixtureRefs();

  it("every fixture manifest parses through the daemon parser", () => {
    for (const ref of refs) {
      const p = join(FIXTURES, ref, "manifest.yaml");
      expect(() => parseManifest(readFileSync(p, "utf-8"), p)).not.toThrow();
    }
  });

  it("covers every ref the cases expect a seat to pull", () => {
    const { cases } = loadEvalCasesFromDir(CASES_DIR);
    // Each expectedPattern is `rig context get\s+<ref>`; recover the ref tail.
    const wanted = new Set<string>();
    for (const c of cases) {
      for (const p of c.expectedPatterns) {
        const m = /rig context get\\s\+(\S+)/.exec(p);
        if (m) wanted.add(m[1]!);
      }
    }
    const have = new Set(refs);
    const missing = [...wanted].filter((r) => !have.has(r));
    expect(missing).toEqual([]);
  });
});
