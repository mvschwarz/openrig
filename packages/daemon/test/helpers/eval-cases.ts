/**
 * slice-07 R6 — the eval-case LOADER. Reads the declarative YAML case files, parses each list,
 * and validates every case through the shared schema. Invalid cases are collected (loud), never
 * silently dropped — the runner and the conformance guard share this one path.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateEvalCase } from "./eval-schema.js";
import type { EvalCase } from "./eval-grader.js";

export interface CaseLoadError {
  file: string;
  index: number;
  codes: string[];
}

export interface LoadedEvalCases {
  cases: EvalCase[];
  errors: CaseLoadError[];
}

/** Load + validate every eval case under `dir` (each `*.yaml` file is a list of cases). */
export function loadEvalCasesFromDir(dir: string): LoadedEvalCases {
  const cases: EvalCase[] = [];
  const errors: CaseLoadError[] = [];
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  for (const file of files) {
    const doc = parseYaml(readFileSync(join(dir, file), "utf-8"));
    const list = Array.isArray(doc) ? doc : [doc];
    list.forEach((raw, index) => {
      const result = validateEvalCase(raw);
      if (result.ok) cases.push(result.case);
      else errors.push({ file, index, codes: result.errors.map((e) => e.code) });
    });
  }
  return { cases, errors };
}
