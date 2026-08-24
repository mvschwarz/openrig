/**
 * slice-07 R6 — the live-model eval GRADER (the deterministic DOOR).
 *
 * A DIFFERENT gate from the scenario runner: scenarios ask "does the structure hold?" with
 * stub seats; evals ask "does a REAL seat pull the right context entry and follow it?" The
 * DOOR grade here is judgment-free and deterministic — expected/forbidden command-pattern match
 * over the captured transcript, plus (loading) a get-precedes-action order check. The authored
 * 1-5 rubric rides each case and is scored by an OPTIONAL, DEFERRED LLM judge — never by grade()
 * (this file mirrors the scenario runner's "judgment is L3, never here" split).
 */

export type EvalCategory = "selection" | "loading";

export interface EvalOrder {
  /** The context pull the seat must run (regex source). */
  getPattern: string;
  /** The domain action the pull must precede (regex source). */
  actionPattern: string;
}

export interface EvalCase {
  id: string;
  name: string;
  category: EvalCategory;
  /** Natural prompt — NO verb named. */
  prompt: string;
  /** Regex sources that must ALL match the captured transcript. */
  expectedPatterns: string[];
  /** Regex sources that must NOT match. */
  forbiddenPatterns?: string[];
  /** Loading-only: the get must precede the action, and no action may occur with no preceding get. */
  order?: EvalOrder;
  /** Authored 1-5 rubric text; judged optionally/deferred, NEVER by grade(). */
  rubric?: string;
}

export interface PatternResult {
  pattern: string;
  matched: boolean;
  type: "expected" | "forbidden";
}

export interface OrderResult {
  getIndex: number;
  actionIndex: number;
  ok: boolean;
  reason?: string;
}

export interface GradeResult {
  caseId: string;
  category: EvalCategory;
  /** The deterministic DOOR grade (what CE-08 thinning consumes). */
  pass: boolean;
  patternResults: PatternResult[];
  order?: OrderResult;
}

/** First match index of a regex source in the transcript, or -1 if absent. */
function firstIndex(source: string, transcript: string): number {
  const m = new RegExp(source).exec(transcript);
  return m ? m.index : -1;
}

/**
 * Grade one case against a captured agent transcript. Pure + deterministic — the DOOR.
 *
 * Selection door = every expectedPattern matches AND no forbiddenPattern matches.
 * Loading door additionally requires the get-before-action ORDER: the get must have happened,
 * and any domain action must come AFTER it (an action with no preceding get is the "acted
 * without loading" failure). The 1-5 rubric is never scored here.
 */
export function grade(evalCase: EvalCase, transcript: string): GradeResult {
  const patternResults: PatternResult[] = [];

  let allExpectedMatched = true;
  for (const source of evalCase.expectedPatterns) {
    const matched = new RegExp(source).test(transcript);
    patternResults.push({ pattern: source, matched, type: "expected" });
    if (!matched) allExpectedMatched = false;
  }

  let noForbiddenMatched = true;
  for (const source of evalCase.forbiddenPatterns ?? []) {
    const matched = new RegExp(source).test(transcript);
    patternResults.push({ pattern: source, matched, type: "forbidden" });
    if (matched) noForbiddenMatched = false;
  }

  const patternsOk = allExpectedMatched && noForbiddenMatched;

  let order: OrderResult | undefined;
  let orderOk = true;
  if (evalCase.order) {
    const getIndex = firstIndex(evalCase.order.getPattern, transcript);
    const actionIndex = firstIndex(evalCase.order.actionPattern, transcript);
    orderOk = getIndex !== -1 && (actionIndex === -1 || getIndex < actionIndex);
    const reason = orderOk
      ? undefined
      : getIndex === -1
        ? "domain action taken with no preceding `rig context get`"
        : "domain action precedes the context get";
    order = { getIndex, actionIndex, ok: orderOk, reason };
  }

  return {
    caseId: evalCase.id,
    category: evalCase.category,
    pass: patternsOk && orderOk,
    patternResults,
    order,
  };
}
