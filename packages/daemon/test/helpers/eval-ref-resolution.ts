/**
 * slice-07 Repairs 1+2 re-review (HIGH-1) — ONE shared case-to-ref validator, used by BOTH the eval
 * run's preflight and the guard test. The production package dir is passed IN (the caller builds it
 * hermetically into a temp dir), so resolution never depends on gitignored worktree residue.
 *
 * Granularity is PER CASE: every case yields exactly one CaseRefResolution, so a case that produces no
 * canonical ref, or a ref absent from the built production package, fails by NAME (never disappears).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase } from "./eval-grader.js";

export interface CaseRefResolution {
  caseId: string;
  /** The canonical ref extracted from the case, or null if none was found. */
  ref: string | null;
  /** ref is a canonical full path (skills/<ns>/<name>). */
  canonical: boolean;
  /** the ref's manifest exists in the built production package. */
  resolved: boolean;
}

/** Extract the ref a `rig context get <ref>` pattern pulls. */
export function extractRef(pattern: string): string | null {
  const m = /rig context get\\s\+(\S+)/.exec(pattern);
  return m ? m[1]! : null;
}

/** One resolution per case (never fewer), against a built production package directory. */
export function resolveCaseRefs(cases: EvalCase[], productionPackageDir: string): CaseRefResolution[] {
  return cases.map((c) => {
    const patterns = [...(c.expectedPatterns ?? [])];
    if (c.order?.getPattern) patterns.push(c.order.getPattern);
    const ref = patterns.map(extractRef).find((r) => r !== null) ?? null;
    const canonical = ref !== null && ref.startsWith("skills/");
    const resolved = canonical && existsSync(join(productionPackageDir, ref, "manifest.yaml"));
    return { caseId: c.id, ref, canonical, resolved };
  });
}

/** Cases whose ref is missing, non-canonical, or absent from the production package. */
export function unresolvedCases(resolutions: CaseRefResolution[]): CaseRefResolution[] {
  return resolutions.filter((r) => !r.resolved);
}

/**
 * Build the EXACT production package under test into a fresh temp dir (hermetic — never reads the
 * gitignored `packages/daemon/context-packs` residue). Returns the temp dir; refs resolve at
 * `<dir>/skills/<ns>/<name>/manifest.yaml`.
 */
export function buildProductionPackage(repoRoot: string): string {
  const out = mkdtempSync(join(tmpdir(), "eval-prod-pkg-"));
  execFileSync("node", [join(repoRoot, "scripts/generate-context-packs.mjs")], {
    env: { ...process.env, OPENRIG_PACKS_OUT: out },
    stdio: "pipe",
  });
  return out;
}
