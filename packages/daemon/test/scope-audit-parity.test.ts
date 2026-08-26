import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  classifyScopeItem as daemonClassifier,
  type ScopeAuditInput,
} from "../src/domain/scope/scope-audit.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const CLASSIFIER_FILES = [
  { cli: "packages/cli/src/lib/scope/scope-audit.ts", daemon: "packages/daemon/src/domain/scope/scope-audit.ts" },
  { cli: "packages/cli/src/lib/scope/dot-id.ts", daemon: "packages/daemon/src/domain/scope/dot-id.ts" },
  { cli: "packages/cli/src/lib/scope/types.ts", daemon: "packages/daemon/src/domain/scope/types.ts" },
  // release-0.4.7 intent-stage: the shared scaffold-placeholder grammar twin
  // (arch AR-1 ruling — one grammar, twin-pinned; see the module header).
  { cli: "packages/cli/src/lib/scope/scaffold-placeholder.ts", daemon: "packages/daemon/src/domain/scope/scaffold-placeholder.ts" },
  // KI-5.3-2: the shared logical-checkbox item grammar twin — one grammar for
  // the review composer, the slice-detail projector, and `rig proof add`, so a
  // byIndex evidence ref names the same promise everywhere (see module header).
  { cli: "packages/cli/src/lib/scope/logical-checkbox.ts", daemon: "packages/daemon/src/domain/scope/logical-checkbox.ts" },
];

const SHARED_FIXTURES: Array<{ label: string; input: ScopeAuditInput }> = [
  {
    label: "present: valid id + PROGRESS.md",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: "id: OPR.0.4.0", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "mission" },
  },
  {
    label: "missing: no PROGRESS.md, no marker",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: "id: OPR.0.4.0", progressFileExists: false, readmeOnlyMarker: false, isActiveRelease: true, level: "mission" },
  },
  {
    label: "malformed: YAML parse error + id line (ghost)",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "id: OPR.0.4.0.1\nbad: {{yaml", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "slice" },
  },
  {
    label: "malformed: YAML parse error without id line",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "broken: {{yaml", progressFileExists: false, readmeOnlyMarker: false, isActiveRelease: true, level: "slice" },
  },
  {
    label: "readme-only: marker set, no PROGRESS.md",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "id: OPR.0.4.0.2\nprogress_rail: readme-only", progressFileExists: false, readmeOnlyMarker: true, isActiveRelease: true, level: "slice" },
  },
  {
    label: "missing-id: frontmatter parses but no id",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "title: Some slice\nstatus: active", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "slice" },
  },
  {
    label: "id-convention-violation: bad mission id",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: "id: not-a-dot-id", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "mission" },
  },
  {
    label: "id-convention-violation: bad slice id",
    input: { id: null, path: "/fix/slice", readmeFrontmatterRaw: "id: not-valid", progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: false, level: "slice" },
  },
  {
    label: "no frontmatter (null): emits missing_id",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: null, progressFileExists: true, readmeOnlyMarker: false, isActiveRelease: true, level: "mission" },
  },
  {
    label: "historical severity: missing progress LOW",
    input: { id: null, path: "/fix/mission", readmeFrontmatterRaw: "id: OPR.0.3.4", progressFileExists: false, readmeOnlyMarker: false, isActiveRelease: false, level: "mission" },
  },
];

describe("scope-audit CLI/daemon parity (CI-FAILING)", () => {
  describe("byte-equivalence", () => {
    for (const pair of CLASSIFIER_FILES) {
      it(`${path.basename(pair.cli)} is byte-equivalent across CLI and daemon`, () => {
        const cliContent = fs.readFileSync(path.join(REPO_ROOT, pair.cli), "utf-8");
        const daemonContent = fs.readFileSync(path.join(REPO_ROOT, pair.daemon), "utf-8");
        expect(daemonContent).toBe(cliContent);
      });
    }

    it("retires the per-commit PROGRESS classifier and its CLI-only inputs everywhere", () => {
      const files = [
        "packages/cli/src/lib/scope/scope-audit.ts",
        "packages/daemon/src/domain/scope/scope-audit.ts",
        "packages/cli/src/commands/scope.ts",
        "packages/daemon/src/routes/scope-audit.ts",
      ];
      for (const file of files) {
        const content = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8");
        expect(content, file).not.toContain("progress_not_updated_on_commit");
        expect(content, file).not.toContain("sliceTouchedByRecentCommit");
        expect(content, file).not.toContain("progressTouchedByRecentCommit");
      }
    });
  });

  describe("shared-fixture output parity", () => {
    let cliClassifier: typeof daemonClassifier;

    it("loads CLI classifier", async () => {
      const mod = await import(
        path.join(REPO_ROOT, "packages/cli/src/lib/scope/scope-audit.ts")
      );
      cliClassifier = mod.classifyScopeItem;
      expect(typeof cliClassifier).toBe("function");
    });

    for (const fixture of SHARED_FIXTURES) {
      it(`fixture: ${fixture.label}`, () => {
        if (!cliClassifier) throw new Error("CLI classifier not loaded");
        const cliResult = cliClassifier(fixture.input);
        const daemonResult = daemonClassifier(fixture.input);
        expect(daemonResult).toEqual(cliResult);
      });
    }
  });
});

// OPR.0.4.4.19 FR-10 — classifier-level backstop tests (run against the
// daemon copy; the parity test above guarantees the CLI copy is identical).
import { describe as describeFr10, it as itFr10, expect as expectFr10 } from "vitest";
import { classifyScopeItem } from "../src/domain/scope/scope-audit.js";

describeFr10("FR-10 backstops (OPR.0.4.4.19)", () => {
  const base = {
    id: null,
    path: "/w/missions/release-x/slices/19-signal-layer",
    readmeFrontmatterRaw: "id: OPR.X.19\nstatus: building",
    progressFileExists: true,
    readmeOnlyMarker: false,
    isActiveRelease: true,
    level: "slice" as const,
  };

  itFr10("C1: a headerless proof artifact yields a finding naming the file, the missing fields, and the fix", () => {
    const result = classifyScopeItem({
      ...base,
      implementationPrdExists: true,
      proofArtifacts: [{ path: "/w/.../proof/rogue.md", frontmatterRaw: null }],
    });
    const finding = result.findings.find((f) => f.kind === "proof_artifact_c1_invalid");
    expectFr10(finding).toBeDefined();
    expectFr10(finding!.path).toBe("/w/.../proof/rogue.md");
    expectFr10(finding!.message).toContain("slice, candidate_sha, artifact_type, verdict, money_evidence");
    expectFr10(finding!.remediation).toContain("rig proof add");
  });

  itFr10("C1: out-of-set values are flagged naming the closed sets; valid headers are clean", () => {
    const bad = classifyScopeItem({
      ...base,
      implementationPrdExists: true,
      proofArtifacts: [{
        path: "/w/.../proof/bad.md",
        frontmatterRaw: "slice: OPR.X.19\ncandidate_sha: abc\nartifact_type: designer\nverdict: SHIP-IT\nmoney_evidence: m",
      }],
    });
    const finding = bad.findings.find((f) => f.kind === "proof_artifact_c1_invalid");
    expectFr10(finding).toBeDefined();
    expectFr10(finding!.message).toContain("designer");
    expectFr10(finding!.message).toContain("SHIP-IT");

    const good = classifyScopeItem({
      ...base,
      implementationPrdExists: true,
      proofArtifacts: [{
        path: "/w/.../proof/good.md",
        frontmatterRaw: "slice: OPR.X.19\ncandidate_sha: abc\nartifact_type: qa\nverdict: CLEAR\nmoney_evidence: the walk shows the decision",
      }],
    });
    expectFr10(good.findings.some((f) => f.kind === "proof_artifact_c1_invalid")).toBe(false);
  });

  itFr10("C7 retired: a current authored node never requires IMPLEMENTATION-PRD.md", () => {
    const result = classifyScopeItem({ ...base, implementationPrdExists: false });
    expectFr10(result.findings.some((f) => f.kind === "missing_impl_prd")).toBe(false);
  });

  itFr10("C7 NEGATIVE: shaping (pre-spec) status with no PRD yields NO missing-spec finding (status-gated)", () => {
    const result = classifyScopeItem({
      ...base,
      readmeFrontmatterRaw: "id: OPR.X.19\nstatus: shaping",
      implementationPrdExists: false,
    });
    expectFr10(result.findings.some((f) => f.kind === "missing_impl_prd")).toBe(false);
  });

  itFr10("inert without caller context: undefined proofArtifacts/implementationPrdExists produce no FR-10 findings", () => {
    const result = classifyScopeItem(base);
    expectFr10(result.findings.some((f) => f.kind === "proof_artifact_c1_invalid" || f.kind === "missing_impl_prd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PM dogfood #1 (qitem-20260720015700-630eef64) — the per-section selection
// must land in BOTH twins identically (byte-parity above already pins the
// classifier + scaffold-placeholder twin files; this pins the VERDICT).
// ---------------------------------------------------------------------------

import { describe as describeDf, it as itDf, expect as expectDf } from "vitest";

describeDf("PM dogfood #1 — twin verdict parity: authored README vs pristine PRD", () => {
  const AUTHORED_README = "# S\n## Intent\nauthored intent\n## Mini-requirements\n1. first authored requirement\n## Proof contract\n- [ ] authored deliverable one — captured\n";
  const PRISTINE_PRD = [
    "# PRD",
    "## Intent",
    "[The recorded intent, verbatim — kept in sync with the slice README.]",
    "## Mini-requirements",
    "1. [The concise one-glance requirement tier — this is where approval starts.]",
    "## Proof contract",
    "- [ ] [One promised deliverable, written as an observable outcome — captured.]",
  ].join("\n");

  const input: ScopeAuditInput = {
    id: null,
    path: "/fix/dogfood/slices/01-placeholder-conventions",
    readmeFrontmatterRaw: "id: OPR.99.0.2.1\nstatus: placeholder",
    progressFileExists: true,
    readmeOnlyMarker: false,
    isActiveRelease: true,
    level: "slice",
    readmeContent: AUTHORED_README,
    implementationPrdContent: PRISTINE_PRD,
  };

  itDf("both twins agree AND neither emits a convention finding for the authored-README/pristine-PRD fixture", async () => {
    const mod = await import(path.join(REPO_ROOT, "packages/cli/src/lib/scope/scope-audit.ts"));
    const cliResult = (mod.classifyScopeItem as typeof daemonClassifier)(input);
    const daemonResult = daemonClassifier(input);
    expectDf(daemonResult).toEqual(cliResult); // twin parity, verdict-for-verdict
    const conventionKinds = daemonResult.findings
      .filter((f) => f.kind === "mini_requirements_missing_or_malformed" || f.kind === "proof_contract_missing_or_malformed")
      .map((f) => f.kind);
    expectDf(conventionKinds).toEqual([]); // RED pre-fix: both findings fire
  });
});
