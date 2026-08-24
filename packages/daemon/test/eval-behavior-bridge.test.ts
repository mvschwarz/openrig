// OPR.0.5.3.5 Q3 harness bridge (mini-req 8, amended) — slice-05 behavior
// probes run in the SAME live-model eval harness as slice-07's selection cases,
// as a distinct case CATEGORY; no second runner. Plus the dispositioned Atom-2
// probe key-gate note (r1): the atom probe shape reconciles with EvalCase —
// `rubric` and `expectedPatterns` become LEGAL probe keys with a closed set,
// instead of the natural mistake being silently dropped.

import { describe, it, expect } from "vitest";
import { validateEvalCase } from "./helpers/eval-schema.js";
import { loadEvalCasesFromDir } from "./helpers/eval-cases.js";
import { runEvals } from "./helpers/eval-runner.js";
import { FakeProvider } from "./helpers/eval-provider.js";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";
import { compileAtomProbesToEvalCases } from "../src/domain/context-packs/probe-eval-bridge.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MANIFEST = `
name: world-install
version: "1"
files:
  - { path: walk.md, role: world }
atoms:
  - id: affordance-width
    address: "walk.md#affordances"
    taxonomy: world
    situations: [fresh, post-compaction]
    purpose: width
    order: 20
    priority: core
    probe:
      prompt: "What can I do here?"
      expect: "Names the profile route and source-labelled pieces."
      expectedPatterns: ['rig context (get|profile)']
      rubric: |
        1 - names nothing
        5 - names the verb family and the labels
  - id: no-probe
    address: walk.md
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: optional
`;

describe("behavior category — the schema admits slice-05's case kind (mini-req 8)", () => {
  it("a behavior case validates; order on a behavior case rejects (order is loading-only)", () => {
    const ok = validateEvalCase({
      id: "beh-01", name: "affordance width returns", category: "behavior",
      prompt: "What can I do here?", expectedPatterns: ["rig context (get|profile)"], rubric: "1-5",
    });
    expect(ok.ok).toBe(true);
    const withOrder = validateEvalCase({
      id: "beh-02", name: "x", category: "behavior", prompt: "p",
      expectedPatterns: ["a"], order: { before: "a", after: "b" },
    });
    expect(withOrder.ok).toBe(false);
  });
});

describe("probe key-gate reconciliation (the dispositioned Atom-2 note)", () => {
  it("expectedPatterns and rubric are LEGAL probe keys; patterns must compile; unknown probe keys reject loud", () => {
    const m = parseManifest(MANIFEST, "m.yaml");
    const probe = m.atoms![0]!.probe!;
    expect(probe.expectedPatterns).toEqual(["rig context (get|profile)"]);
    expect(probe.rubric).toContain("names the verb family");
    expect(() => parseManifest(MANIFEST.replace("expectedPatterns: ['rig context (get|profile)']", "expectedPatterns: ['(unclosed']"), "m.yaml"))
      .toThrow(/regex|compil/i);
    expect(() => parseManifest(MANIFEST.replace("rubric:", "rubrics:"), "m.yaml"))
      .toThrow(/unknown.*rubrics|rubrics.*unknown/i);
  });
});

describe("compileAtomProbesToEvalCases — atoms feed the ONE harness as data, no second runner", () => {
  it("probed atoms compile to behavior-category case DATA that the harness's own schema validates", () => {
    const m = parseManifest(MANIFEST, "m.yaml");
    const cases = compileAtomProbesToEvalCases(m, "packs/world");
    expect(cases).toHaveLength(1); // no-probe atom skipped
    const c = cases[0]! as Record<string, unknown>;
    expect(c["category"]).toBe("behavior");
    expect(c["id"]).toBe("packs/world/affordance-width");
    expect(c["prompt"]).toBe("What can I do here?");
    const validated = validateEvalCase(c);
    expect(validated.ok).toBe(true);
  });
});

describe("ONE HARNESS (the door's shape): behavior + selection grade in the SAME invocation", () => {
  it("loadEvalCasesFromDir + runEvals over a mixed dir records grades for BOTH categories in one run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s05-evals-"));
    try {
      writeFileSync(join(dir, "selection.yaml"), [
        "- id: sel-x",
        "  name: selects the entry",
        "  category: selection",
        "  prompt: \"bring the fleet back\"",
        "  expectedPatterns: ['rig context get\\s+core/rig-lifecycle']",
      ].join("\n"));
      writeFileSync(join(dir, "behavior.yaml"), [
        "- id: beh-x",
        "  name: affordance width returns",
        "  category: behavior",
        "  prompt: \"What can I do here?\"",
        "  expectedPatterns: ['rig context (get|profile)']",
      ].join("\n"));
      const { cases, errors } = loadEvalCasesFromDir(dir);
      expect(errors).toEqual([]);
      expect(cases.map((c) => c.category).sort()).toEqual(["behavior", "selection"]);
      const provider = new FakeProvider({
        "bring the fleet back": "I'll run rig context get core/rig-lifecycle first",
        "What can I do here?": "rig context profile serves labelled pieces",
      });
      const summary = await runEvals(cases, provider);
      expect(summary.total).toBe(2);
      expect(Object.keys(summary.byCategory).sort()).toEqual(["behavior", "selection"]);
      expect(summary.passed).toBe(2); // both transcripts match their patterns
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
