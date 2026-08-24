// OPR.0.5.3.5 Q3 harness bridge (mini-req 8, amended per desk ruling 9103302d):
// slice-05's behavior probes execute in the SAME live-model eval harness as
// slice-07's selection/loading cases, as the "behavior" case CATEGORY — one
// harness, one runner, one grading door; two runners would fork the eval
// convention itself (the drift class this release keeps killing).
//
// This bridge is DATA-SHAPED on purpose: it compiles atom probes (mini-req 1
// metadata) into plain eval-case objects that the harness validates through
// ITS OWN schema at load time — exactly how the authored YAML cases travel.
// No import from the harness's modules, so the product side and the
// test-system side stay decoupled by data (the schema's own stated design:
// "no cross-package TS import"), and the one-harness property is preserved
// by construction rather than by discipline.

import type { ContextPackManifest } from "./context-pack-types.js";

/** A plain eval-case object in the harness's declarative format. The harness's
 *  validateEvalCase is the authority on this shape; the bridge emits data. */
export type CompiledEvalCaseData = Record<string, unknown>;

/**
 * Compile every probed atom of a manifest into behavior-category eval-case
 * data. Atoms without probes are skipped (a probe is acceptance evidence,
 * not an obligation). Case ids are namespaced by the pack ref so cases from
 * multiple packs never collide in one harness run.
 *
 * The mapping, field by field:
 *   id               <- <packRef>/<atomId>
 *   name             <- the probe's expect (the observable-behavior contract
 *                       IS the case's human name — what a grader reads first)
 *   category         <- "behavior"
 *   prompt           <- probe.prompt (the natural prompt, mini-req 2)
 *   expectedPatterns <- probe.expectedPatterns (the deterministic door leg;
 *                       validated compilable at manifest ingest)
 *   rubric           <- probe.rubric, else the expect prose (the judged leg
 *                       always has at least the behavior contract to judge by)
 */
export interface CompiledProbeCases {
  cases: CompiledEvalCaseData[];
  /** Probes that could not become harness cases, WITH reasons — a bound the
   *  caller must surface (no silent caps): a probe without expectedPatterns
   *  has no deterministic-door leg, and the bridge refuses both to fabricate
   *  a pattern from prose and to lose the atom silently. */
  skipped: Array<{ atomId: string; reason: string }>;
}

export function compileAtomProbesToEvalCases(manifest: ContextPackManifest, packRef: string): CompiledProbeCases {
  const cases: CompiledEvalCaseData[] = [];
  const skipped: CompiledProbeCases["skipped"] = [];
  for (const atom of manifest.atoms ?? []) {
    if (!atom.probe) continue;
    if (!atom.probe.expectedPatterns || atom.probe.expectedPatterns.length === 0) {
      skipped.push({
        atomId: atom.id,
        reason: "probe has no expectedPatterns — the harness's deterministic door requires at least one compilable pattern; author them on the atom's probe",
      });
      continue;
    }
    cases.push({
      id: `${packRef}/${atom.id}`,
      name: atom.probe.expect,
      category: "behavior",
      prompt: atom.probe.prompt,
      expectedPatterns: atom.probe.expectedPatterns,
      rubric: atom.probe.rubric ?? atom.probe.expect,
    });
  }
  return { cases, skipped };
}
