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
