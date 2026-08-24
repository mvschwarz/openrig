/**
 * slice-07 R6 — the eval RUNNER. Drives each case through the provider, grades the captured
 * transcript at the deterministic DOOR, and produces the recorded grades + a summary. Pure
 * orchestration over the injected provider — no model access here.
 */

import { grade, type EvalCase, type GradeResult } from "./eval-grader.js";
import type { EvalProvider } from "./eval-provider.js";

export interface CaseOutcome {
  case: EvalCase;
  transcript: string;
  grade: GradeResult;
  /** Set when the provider failed to execute the case (distinct from a graded FAIL). */
  error?: string;
}

export interface EvalRunSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  byCategory: Record<string, { total: number; passed: number }>;
  outcomes: CaseOutcome[];
}

/** Run every case through the provider + door grader. Recorded grades ride each CaseOutcome. */
export async function runEvals(cases: EvalCase[], provider: EvalProvider): Promise<EvalRunSummary> {
  const outcomes: CaseOutcome[] = [];

  for (const evalCase of cases) {
    let transcript = "";
    let error: string | undefined;
    try {
      const result = await provider.run(evalCase.prompt);
      if (result.error) error = result.error;
      else transcript = result.transcript;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (error !== undefined) {
      outcomes.push({
        case: evalCase,
        transcript: "",
        grade: { caseId: evalCase.id, category: evalCase.category, pass: false, patternResults: [] },
        error,
      });
    } else {
      outcomes.push({ case: evalCase, transcript, grade: grade(evalCase, transcript) });
    }
  }

  const byCategory: Record<string, { total: number; passed: number }> = {};
  let passed = 0;
  let failed = 0;
  let errored = 0;
  for (const outcome of outcomes) {
    const cat = outcome.case.category;
    byCategory[cat] ??= { total: 0, passed: 0 };
    byCategory[cat].total += 1;
    if (outcome.error !== undefined) {
      errored += 1;
    } else if (outcome.grade.pass) {
      passed += 1;
      byCategory[cat].passed += 1;
    } else {
      failed += 1;
    }
  }

  return { total: outcomes.length, passed, failed, errored, byCategory, outcomes };
}
