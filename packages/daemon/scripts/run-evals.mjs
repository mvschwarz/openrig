#!/usr/bin/env -S node --import tsx
/*
 * slice-07 R6 — the eval runner CLI (sibling to run-scenarios.mjs; the eval gate, not the
 * determinism gate). Loads the authored cases, runs them through a provider, grades each captured
 * transcript at the deterministic DOOR, writes recorded grades, and exits nonzero on any
 * fail/error.
 *
 *   run-evals.mjs [--provider fake|rig] [--transcripts <json>] [--out <json>]
 *
 * --provider fake (default): a deterministic provider whose transcripts come from --transcripts
 *   (a JSON map of prompt -> transcript); absent prompts ERROR (never a silent green). This is the
 *   CI-runnable path.
 * --provider rig: the live-seat provider (the non-author proof-contract door) — see
 *   eval-rig-provider.ts; it throws until the non-author wires seat spawn + capture.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalCasesFromDir } from "../test/helpers/eval-cases.ts";
import { runEvals } from "../test/helpers/eval-runner.ts";
import { FakeProvider } from "../test/helpers/eval-provider.ts";
import { RigSeatProvider } from "../test/helpers/eval-rig-provider.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = resolve(HERE, "..", "..", "test-system", "evals", "cases");
const FIXTURES = resolve(HERE, "..", "..", "test-system", "evals", "fixtures");

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const providerName = opt("--provider", "fake");
const outPath = opt("--out", null);

const { cases, errors } = loadEvalCasesFromDir(CASES_DIR);
if (errors.length > 0) {
  console.error("[REFUSED] invalid eval cases:", JSON.stringify(errors));
  process.exit(2);
}

let provider;
if (providerName === "rig") {
  provider = new RigSeatProvider({ packsRoot: FIXTURES });
} else {
  const tPath = opt("--transcripts", null);
  const transcripts = tPath ? JSON.parse(readFileSync(tPath, "utf-8")) : {};
  provider = new FakeProvider(transcripts);
}

const summary = await runEvals(cases, provider);
const recorded = {
  provider: provider.name,
  total: summary.total,
  passed: summary.passed,
  failed: summary.failed,
  errored: summary.errored,
  byCategory: summary.byCategory,
  grades: summary.outcomes.map((o) => ({
    id: o.case.id,
    category: o.case.category,
    pass: o.grade.pass,
    error: o.error ?? null,
  })),
};
if (outPath) writeFileSync(outPath, JSON.stringify(recorded, null, 2));

console.log(`evals[${provider.name}] ${summary.passed}/${summary.total} pass, ${summary.failed} fail, ${summary.errored} error`);
for (const g of recorded.grades) {
  const tag = g.pass ? "PASS" : g.error ? "ERROR" : "FAIL";
  console.log(`  ${tag} ${g.id}${g.error ? ` — ${g.error}` : ""}`);
}
process.exit(summary.failed > 0 || summary.errored > 0 ? 1 : 0);
