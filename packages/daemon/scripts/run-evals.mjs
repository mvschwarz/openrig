#!/usr/bin/env -S node --import tsx
/*
 * slice-07 R6 — the eval runner CLI (sibling to run-scenarios.mjs; the eval gate, not the
 * determinism gate). Loads the authored cases, runs them through a provider, grades each captured
 * transcript at the deterministic DOOR, writes recorded grades, and exits nonzero on any
 * fail/error.
 *
 *   RUN IT (the TS helpers need the tsx loader, so use the package command, which supplies it):
 *     npm run eval -w packages/daemon -- [--provider fake|rig] [--transcripts <json>] [--out <json>]
 *   Or directly: node --import tsx packages/daemon/scripts/run-evals.mjs [args]
 *   (The file ships executable; ./run-evals.mjs works where `env -S` is supported.)
 *
 * --provider fake (default): a deterministic provider whose transcripts come from --transcripts
 *   (a JSON map of prompt -> transcript); absent prompts ERROR (never a silent green). This is the
 *   CI-runnable path.
 * --provider rig: the LIVE-seat provider (the proof-contract door). Requires ONE of:
 *     --seat <session>      attach to an existing live seat (never torn down), or
 *     --seat-spec <rig.yaml> `rig up` a scratch rig and drive its single seat
 *                            (torn down via `rig down` at the end).
 *   One persistent seat/generation serves every case; the boundary is the seat's
 *   append-only transcript (read out-of-band, no marker send — round-5 custody);
 *   the leading input echo is excluded from grading by the provider.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalCasesFromDir } from "../test/helpers/eval-cases.ts";
import { runEvals } from "../test/helpers/eval-runner.ts";
import { FakeProvider } from "../test/helpers/eval-provider.ts";
import { RigSeatProvider } from "../test/helpers/eval-rig-provider.ts";
import { recordedGrade } from "../test/helpers/eval-report.ts";
import { buildProductionPackage, resolveCaseRefs, unresolvedCases } from "../test/helpers/eval-ref-resolution.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CASES_DIR = resolve(HERE, "..", "..", "test-system", "evals", "cases");
// REPAIR (re-review HIGH-1): the eval RUN resolves refs against the EXACT production package, BUILT
// hermetically into a temp dir (never the gitignored context-packs residue), and validates them in
// its OWN preflight for EVERY provider — not just rig.
// The temp package is removed on process exit (fail-safe registered inside buildProductionPackage).
const PRODUCTION_PACKAGE = buildProductionPackage(REPO).dir;

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

// PREFLIGHT (shared validator — the same one the guard test uses): every case must yield a canonical
// ref that resolves in the built production package, or the whole run refuses. This makes production
// resolution part of the run, not a side test.
const unresolved = unresolvedCases(resolveCaseRefs(cases, PRODUCTION_PACKAGE));
if (unresolved.length > 0) {
  console.error(
    "[REFUSED] eval refs do not resolve in the production package: " +
      unresolved.map((u) => `${u.caseId}:${u.ref ?? "<none>"}`).join(", "),
  );
  process.exit(2);
}

let provider;
if (providerName === "rig") {
  const seat = opt("--seat", null);
  const spec = opt("--seat-spec", null);
  if ((seat === null) === (spec === null)) {
    console.error(
      "[REFUSED] --provider rig drives ONE persistent real seat and needs exactly one of:\n" +
        "  --seat <session>       attach to an existing live seat (never torn down)\n" +
        "  --seat-spec <rig.yaml> spawn a scratch rig via `rig up` and drive its seat",
    );
    process.exit(2);
  }
  const { createRigCliSession } = await import("../test/helpers/eval-rig-session.ts");
  provider = new RigSeatProvider({
    productionPackage: PRODUCTION_PACKAGE,
    session: createRigCliSession(seat !== null ? { seat } : { spec }),
  });
} else {
  const tPath = opt("--transcripts", null);
  const transcripts = tPath ? JSON.parse(readFileSync(tPath, "utf-8")) : {};
  provider = new FakeProvider(transcripts);
}

let summary;
try {
  summary = await runEvals(cases, provider);
} finally {
  // Retire the persistent seat exactly once (idempotent; no-op for fake/attach).
  // A teardown failure must NOT destroy the run's results — the grades are the
  // product; a leftover rig is a named warning for manual `rig down`.
  if (typeof provider.dispose === "function") {
    try {
      await provider.dispose();
    } catch (e) {
      console.error(`[WARN] seat retirement failed — tear the scratch rig down manually with 'rig down': ${e.message}`);
    }
  }
}
const recorded = {
  provider: provider.name,
  total: summary.total,
  passed: summary.passed,
  failed: summary.failed,
  errored: summary.errored,
  byCategory: summary.byCategory,
  // Each recorded grade carries its own evidence (patternResults + order + a FAIL reason), so the
  // artifact explains its verdict — CE-08 must tell "pulled nothing" from "pulled late" from "wrong".
  grades: summary.outcomes.map(recordedGrade),
};
if (outPath) writeFileSync(outPath, JSON.stringify(recorded, null, 2));

console.log(`evals[${provider.name}] ${summary.passed}/${summary.total} pass, ${summary.failed} fail, ${summary.errored} error`);
for (const g of recorded.grades) {
  const tag = g.pass ? "PASS" : g.error ? "ERROR" : "FAIL";
  const detail = g.error ? ` — ${g.error}` : !g.pass && g.reason ? ` — ${g.reason}` : "";
  console.log(`  ${tag} ${g.id}${detail}`);
}
process.exit(summary.failed > 0 || summary.errored > 0 ? 1 : 0);
