/**
 * slice-07 Repairs 1+2 re-review (HIGH-1) — ONE shared case-to-ref validator, used by BOTH the eval
 * run's preflight and the guard test. The production package dir is passed IN (the caller builds it
 * hermetically into a temp dir), so resolution never depends on gitignored worktree residue.
 *
 * Granularity is PER CASE: every case yields exactly one CaseRefResolution, so a case that produces no
 * canonical ref, or a ref absent from the built production package, fails by NAME (never disappears).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase, EvalCategory } from "./eval-grader.js";

export interface CaseRefResolution {
  caseId: string;
  category: EvalCategory;
  /** Only selection/loading cases have a context-pull contract; behavior cases do not. */
  requiresRef: boolean;
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
    // Only selection/loading cases contract to pull context; behavior cases (slice-05 Q3) assert
    // observable behavior and carry no context ref, so they are never subject to ref resolution.
    const requiresRef = c.category === "selection" || c.category === "loading";
    const patterns = [...(c.expectedPatterns ?? [])];
    if (c.order?.getPattern) patterns.push(c.order.getPattern);
    const ref = patterns.map(extractRef).find((r) => r !== null) ?? null;
    const canonical = ref !== null && ref.startsWith("skills/");
    const resolved = canonical && existsSync(join(productionPackageDir, ref, "manifest.yaml"));
    return { caseId: c.id, category: c.category, requiresRef, ref, canonical, resolved };
  });
}

/**
 * Cases that MUST resolve a canonical production ref but do not — i.e. selection/loading cases whose
 * ref is missing, non-canonical, or absent from the production package. Behavior cases carry no
 * context-pull contract and are never included, so a valid behavior case never refuses the run.
 */
export function unresolvedCases(resolutions: CaseRefResolution[]): CaseRefResolution[] {
  return resolutions.filter((r) => r.requiresRef && !r.resolved);
}

export interface BuiltProductionPackage {
  /** The built package dir; refs resolve at `<dir>/skills/<ns>/<name>/manifest.yaml`. */
  dir: string;
  /** Remove the temp package. Idempotent; also registered as a process-exit fail-safe. */
  cleanup: () => void;
}

/**
 * Build the EXACT production package under test into a fresh temp dir (hermetic — never reads the
 * gitignored `packages/daemon/context-packs` residue). The temp dir is removed on process exit as a
 * fail-safe (success OR error path), and the returned `cleanup` lets a caller reclaim it eagerly —
 * so a repeatedly-run gate never leaks temp packages.
 */
export function buildProductionPackage(repoRoot: string): BuiltProductionPackage {
  const out = mkdtempSync(join(tmpdir(), "eval-prod-pkg-"));
  const cleanup = () => {
    try {
      rmSync(out, { recursive: true, force: true });
    } catch {
      // best-effort — the dir may already be gone
    }
  };
  process.once("exit", cleanup);
  execFileSync("node", [join(repoRoot, "scripts/generate-context-packs.mjs")], {
    env: { ...process.env, OPENRIG_PACKS_OUT: out },
    stdio: "pipe",
  });
  return { dir: out, cleanup };
}
