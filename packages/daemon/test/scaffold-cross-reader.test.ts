// release-0.4.7 intent-stage/scaffold-projection — T5: the NAMED R3
// divergence test. ONE placeholder-only fixture (a pristine `rig scope slice
// create` output, template-derived via the real CLI renderers) is read by all
// three consumers of the shared scaffold-placeholder grammar, and they must
// AGREE it carries no authored content:
//   1. scope-audit (both twins — parity-pinned) → the
//      proof_contract_missing_or_malformed finding FIRES,
//   2. review compose → extractProofContract = [] (promised empty),
//   3. slice-detail-projector → acceptance items = 0.
// audit-says-present / review-says-absent is the seam map's R3 class; this
// test makes any future divergence a CI failure, not a dogfood finding.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { classifyScopeItem } from "../src/domain/scope/scope-audit.js";
import { extractProofContract } from "../src/domain/review/compose.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

let tpl: { readme: string; prd: string; progress: string };

beforeAll(async () => {
  const mod = await import(join(REPO_ROOT, "packages/cli/src/lib/scope/templates.ts"));
  const opts = {
    id: "OPR.T.97",
    slice_number: "97",
    slug: "crossread",
    mission: "release-t",
    title: "Crossread",
    created_date: "2026-07-11",
  };
  tpl = {
    readme: mod.renderSliceTemplate("placeholder", opts),
    prd: mod.renderImplementationPrdTemplate(opts),
    progress: mod.renderSliceProgressTemplate("Crossread"),
  };
});

describe("T5 — shared-helper agreement across the three readers (the R3 pin, proven)", () => {
  let db: Database.Database;
  let cleanupRoot: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      missionControlActionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanupRoot = mkdtempSync(join(tmpdir(), "scaffold-crossreader-"));
  });

  afterEach(() => {
    db.close();
    rmSync(cleanupRoot, { recursive: true, force: true });
  });

  it("audit + compose + acceptance all read the pristine fixture as carrying NO authored deliverables", () => {
    // Reader 1 — scope-audit: the contract-malformed finding FIRES on a
    // placeholder-only PRD (pre-fix it stayed silent: checkbox-presence
    // counted as a contract).
    const audit = classifyScopeItem({
      id: "OPR.T.97",
      path: "/fixture/97-crossread",
      readmeFrontmatterRaw: "id: OPR.T.97",
      progressFileExists: true,
      readmeOnlyMarker: false,
      isActiveRelease: true,
      level: "slice",
      readmeContent: tpl.readme,
      implementationPrdContent: tpl.prd,
    });
    expect(audit.findings.map((f) => f.kind)).toContain("proof_contract_missing_or_malformed");

    // Reader 2 — review compose: promised = [] (placeholder-only).
    expect(extractProofContract(tpl.prd)).toEqual([]);

    // Reader 3 — slice-detail-projector: acceptance = 0 items.
    const slicesRoot = join(cleanupRoot, "slices");
    const dir = join(slicesRoot, "97-crossread");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), tpl.readme);
    writeFileSync(join(dir, "IMPLEMENTATION-PRD.md"), tpl.prd);
    writeFileSync(join(dir, "PROGRESS.md"), tpl.progress);
    const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
    const projector = new SliceDetailProjector({ db, indexer, workflowSpecCache: new WorkflowSpecCache(db) });
    const slice = indexer.get("97-crossread");
    expect(slice).toBeTruthy();
    expect(projector.project(slice!).acceptance.totalItems).toBe(0);
  });

  it("the same three readers all see an AUTHORED contract line (agreement holds in the positive too)", () => {
    const prd = tpl.prd.replace(
      /^## Proof contract\s*$/m,
      "## Proof contract\n\n- [ ] phone journey video",
    );
    const audit = classifyScopeItem({
      id: "OPR.T.97",
      path: "/fixture/97-crossread",
      readmeFrontmatterRaw: "id: OPR.T.97",
      progressFileExists: true,
      readmeOnlyMarker: false,
      isActiveRelease: true,
      level: "slice",
      readmeContent: tpl.readme,
      implementationPrdContent: prd,
    });
    expect(audit.findings.map((f) => f.kind)).not.toContain("proof_contract_missing_or_malformed");
    expect(extractProofContract(prd).map((i) => i.text)).toEqual(["phone journey video"]);
  });
});

// ---------------------------------------------------------------------------
// release-0.4.7 placeholder-suppression completeness — T-A1 (audit mini-reqs
// arm learns the merged grammar) + T-A2 (the IF-3 paren-grammar HEAL:
// RED at base b8c11535 proves today's audit-absent/review-present divergence;
// green post-change proves audit joined compose's already-ratified grammar —
// an arch-framed expected-change disclosure, not a regression).
// ---------------------------------------------------------------------------

function auditFor(prd: string) {
  return classifyScopeItem({
    id: "OPR.T.96",
    path: "/fixture/96-minireqs",
    readmeFrontmatterRaw: "id: OPR.T.96",
    progressFileExists: true,
    readmeOnlyMarker: false,
    isActiveRelease: true,
    level: "slice",
    readmeContent: "# 96\n\n## Intent\n\nauthored\n",
    implementationPrdContent: prd,
  });
}

describe("T-A1 — audit mini-reqs arm counts only AUTHORED numbered items", () => {
  it("placeholder-only mini-reqs → mini_requirements finding FIRES (was: silent)", () => {
    const audit = auditFor(tpl.prd); // pristine template: `1. [...]` placeholder + placeholder contract
    expect(audit.findings.map((f) => f.kind)).toContain("mini_requirements_missing_or_malformed");
  });

  it("authored dot-form mini-reqs → no mini_requirements finding", () => {
    const prd = tpl.prd.replace(/^1\. \[.*\]$/m, "1. One real observable outcome.");
    const audit = auditFor(prd);
    expect(audit.findings.map((f) => f.kind)).not.toContain("mini_requirements_missing_or_malformed");
  });
});

describe("T-A2 — the IF-3 heal: `1)` paren-form authored items — audit joins compose's grammar", () => {
  it("paren-form authored mini-reqs: audit finding ABSENT and compose reads authored (agreement)", async () => {
    const prd = tpl.prd.replace(/^1\. \[.*\]$/m, "1) One real observable outcome.");
    // Reader 1 — audit: no malformed finding (RED at base: dot-only regex misses `1)`).
    const audit = auditFor(prd);
    expect(audit.findings.map((f) => f.kind)).not.toContain("mini_requirements_missing_or_malformed");
    // Reader 2 — compose: authored TRUE via the same shared grammar.
    const { extractMiniReqs, hasAuthoredMiniReqs } = await import("../src/domain/review/compose.js");
    expect(hasAuthoredMiniReqs(extractMiniReqs(prd))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PM dogfood #1 (qitem-20260720015700-630eef64) — the INVERSE agreement: an
// authored README section wins over a PRISTINE scaffold-only PRD section, and
// all three grammar consumers agree. The projector leg asserts the VM-006
// QA-verdict LIFT (done:true, doneVia:"qa-verdict") — the discriminator: row
// existence alone passes today via the README scan; the lift cannot fire
// while `promised` extracts from the pristine PRD only.
// ---------------------------------------------------------------------------

describe("PM dogfood #1 — authored README + pristine PRD: three-reader agreement (RED pre-fix)", () => {
  let db2: Database.Database;
  let root2: string;

  beforeEach(() => {
    db2 = createDb();
    migrate(db2, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      missionControlActionsSchema,
    ]);
    db2.prepare(`INSERT INTO rigs (id, name) VALUES ('r-2', 'rig')`).run();
    root2 = mkdtempSync(join(tmpdir(), "scaffold-crossreader-df1-"));
  });

  afterEach(() => {
    db2.close();
    rmSync(root2, { recursive: true, force: true });
  });

  function authoredReadme(): string {
    // Real renderer output with ONLY the two convention rows authored — the
    // dogfood fixture shape (status stays `placeholder` in the frontmatter).
    return tpl.readme
      .replace(/^1\. \[.*\]$/m, "1. first authored requirement")
      .replace(/^- \[ \] \[.*\]$/m, "- [ ] authored deliverable one");
  }

  const QA_ARTIFACT = [
    "---",
    "slice: 97-crossread",
    "candidate_sha: cafe1234",
    "artifact_type: qa",
    "verdict: PASS",
    'money_evidence: "compared the rendered UI to the authored contract row"',
    "self_check: compared against the authored contract row",
    "evidences:",
    "  - authored deliverable one",
    "---",
    "",
    "QA verified the authored deliverable.",
  ].join("\n");

  it("reader 1 — audit: NO convention finding for authored README + pristine PRD", () => {
    const audit = classifyScopeItem({
      id: "OPR.T.97",
      path: "/fixture/97-crossread",
      readmeFrontmatterRaw: "id: OPR.T.97\nstatus: placeholder",
      progressFileExists: true,
      readmeOnlyMarker: false,
      isActiveRelease: true,
      level: "slice",
      readmeContent: authoredReadme(),
      implementationPrdContent: tpl.prd,
    });
    const kinds = audit.findings.map((f) => f.kind);
    expect(kinds).not.toContain("mini_requirements_missing_or_malformed");
    expect(kinds).not.toContain("proof_contract_missing_or_malformed");
  });

  it("reader 2 — review compose: PLAN + DELIVERED project the authored README sections", async () => {
    const { composeSliceReview } = await import("../src/domain/review/compose.js");
    const r = composeSliceReview({
      slice: { name: "97-crossread", id: "OPR.T.97", title: "Crossread", missionId: "release-t" },
      readme: authoredReadme(),
      prd: tpl.prd,
      proofMd: null,
      artifacts: [],
      lockedArtifacts: [],
      mediaRefs: [],
      proofDirExists: false,
      attention: [],
      agents: [],
      activeQitemPresent: false,
      git: { mainTip: "tip99999", mergeSha: null, mergeIsAncestorOfTip: null, candidateBehindTip: 0 },
      approval: { spec: null, delivery: null },
      nowIso: "2026-07-20T00:00:00.000Z",
    });
    expect(r.plan.concise.text).not.toBeNull(); // RED pre-fix: no projection
    expect(r.plan.concise.text!).toContain("first authored requirement");
    expect(r.delivered.items.map((i) => i.promised.text)).toEqual(["authored deliverable one"]);
  });

  it("reader 3 — slice-detail-projector: the README-authored contract row LIFTS on a matching QA PASS (done:true, doneVia:'qa-verdict')", () => {
    const slicesRoot = join(root2, "slices");
    const dir = join(slicesRoot, "97-crossread");
    mkdirSync(join(dir, "proof"), { recursive: true });
    writeFileSync(join(dir, "README.md"), authoredReadme());
    writeFileSync(join(dir, "IMPLEMENTATION-PRD.md"), tpl.prd);
    writeFileSync(join(dir, "PROGRESS.md"), tpl.progress);
    writeFileSync(join(dir, "proof", "qa-verify.md"), QA_ARTIFACT);
    const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db: db2 });
    const projector = new SliceDetailProjector({ db: db2, indexer, workflowSpecCache: new WorkflowSpecCache(db2) });
    const slice = indexer.get("97-crossread");
    expect(slice).toBeTruthy();
    const row = projector.project(slice!).acceptance.items.find((i) => i.text === "authored deliverable one");
    expect(row, "README-authored contract row must appear as an acceptance item").toBeTruthy();
    // The discriminator: the QA-verdict lift requires `promised` to carry the
    // README-authored contract item — impossible while extraction is PRD-only.
    expect(row!.done).toBe(true);
    expect(row!.doneVia).toBe("qa-verdict");
  });
});
