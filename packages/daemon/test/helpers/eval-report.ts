/**
 * slice-07 R6 (F1 repair) — the eval REPORTER. Turns a graded outcome into a recorded entry that
 * EXPLAINS ITS OWN VERDICT: the pattern results and the loading order diagnostic ride the record,
 * and a FAIL carries a human reason. A gate that emits pass/fail with no reason is the exact class
 * this release keeps killing (CE-08 consumes these grades — it must be able to tell "pulled
 * nothing" from "pulled late" from "pulled the wrong entry").
 */

import type { EvalCategory, GradeResult, OrderResult, PatternResult } from "./eval-grader.js";
import type { CaseOutcome } from "./eval-runner.js";

export interface RecordedGrade {
  id: string;
  category: EvalCategory;
  pass: boolean;
  patternResults: PatternResult[];
  order: OrderResult | null;
  /** Why a FAIL failed (null on pass; provider errors carry `error` instead). */
  reason: string | null;
  error: string | null;
}

/** A human reason a graded FAIL failed, from the diagnostics grade() already computed. */
export function failReason(grade: GradeResult): string {
  if (grade.order && !grade.order.ok && grade.order.reason) return grade.order.reason;
  const missing = grade.patternResults
    .filter((p) => p.type === "expected" && !p.matched)
    .map((p) => p.pattern);
  const forbidden = grade.patternResults
    .filter((p) => p.type === "forbidden" && p.matched)
    .map((p) => p.pattern);
  const parts: string[] = [];
  if (missing.length) parts.push(`expected not matched: ${missing.join(", ")}`);
  if (forbidden.length) parts.push(`forbidden matched: ${forbidden.join(", ")}`);
  return parts.join("; ") || "grade failed";
}

/** Build the recorded grade entry for an outcome — it carries the evidence for its own verdict. */
export function recordedGrade(outcome: CaseOutcome): RecordedGrade {
  const g = outcome.grade;
  const isError = outcome.error !== undefined;
  return {
    id: outcome.case.id,
    category: outcome.case.category,
    pass: g.pass,
    patternResults: g.patternResults,
    order: g.order ?? null,
    reason: isError || g.pass ? null : failReason(g),
    error: outcome.error ?? null,
  };
}
