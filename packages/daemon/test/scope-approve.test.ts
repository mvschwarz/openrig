// OPR.0.4.4.19 FR-9 — scope approve: frontmatter sole-writer + append-only
// audit row. Includes the plan-review QA guardrail: an audit-write failure
// can NEVER leave a trusted half-stamp (frontmatter restored, loud error) —
// and NO audit row is ever deleted (the arch-lead ordering pin).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";
import { ScopeApproveError, ScopeApproveService } from "../src/domain/scope/scope-approve.js";
// Stage-3 Lever A (REV4 348f84f3 §4/§6) — gather+compose render-parity RED drives
// the shipped ReviewGatherer/composer over a fixture slice; mirror the proven
// review-freeze construction (schemas + SliceIndexer + writeFixtureSlice).
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { ReviewGatherer } from "../src/domain/review/gather.js";
import { makeFixtureWorkspace, writeFixtureSlice } from "./review-fixtures.js";

describe("ScopeApproveService (OPR.0.4.4.19 FR-9)", () => {
  let db: Database.Database;
  let actionLog: MissionControlActionLog;
  let auditBrowse: MissionControlAuditBrowse;
  let missionsRoot: string;
  let sliceDir: string;
  let readmePath: string;

  function service(overrides?: { actionLog?: MissionControlActionLog }): ScopeApproveService {
    return new ScopeApproveService({
      missionsRoot: () => missionsRoot,
      actionLog: overrides?.actionLog ?? actionLog,
    });
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, queueItemsSchema, missionControlActionsSchema]);
    actionLog = new MissionControlActionLog(db);
    auditBrowse = new MissionControlAuditBrowse(db);
    missionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scope-approve-"));
    sliceDir = path.join(missionsRoot, "release-x", "slices", "19-signal-layer");
    fs.mkdirSync(sliceDir, { recursive: true });
    readmePath = path.join(sliceDir, "README.md");
    fs.writeFileSync(readmePath, "---\nid: OPR.X.19\nstatus: building\n---\n\n# The slice\nbody prose stays intact\n");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(missionsRoot, { recursive: true, force: true });
  });

  function frontmatterOf(p: string): Record<string, unknown> {
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(fs.readFileSync(p, "utf8"));
    return m ? (YAML.parse(m[1]!) as Record<string, unknown>) : {};
  }

  const baseInput = {
    scopeTier: "slice" as const,
    scopePath: "release-x/slices/19-signal-layer",
    approvalScope: "delivery" as const,
    actorSession: "human-review@kernel",
  };

  it("delivery approve writes approved-by/-at AND the audit row with the pinned target contract — both in one operation", () => {
    const result = service().approve(baseInput);
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-by"]).toBe("human-review@kernel");
    expect(typeof fm["approved-at"]).toBe("string");
    // Body prose untouched.
    expect(fs.readFileSync(readmePath, "utf8")).toContain("body prose stays intact");
    // The audit row carries the pinned shape.
    const rows = auditBrowse.query({ scopeId: "OPR.X.19" }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actionVerb).toBe("approve");
    expect(rows[0]!.actorSession).toBe("human-review@kernel");
    expect(rows[0]!.qitemId).toBeNull();
    expect(rows[0]!.auditNotes).toMatchObject({
      kind: "scope-approval",
      scope_tier: "slice",
      scope_id: "OPR.X.19",
      scope_path: "release-x/slices/19-signal-layer",
      approval_scope: "delivery",
      on_behalf_of: null,
    });
    expect(result.freezeFired).toBe(false);
  });

  it("one-query lookup by scope target + approver + approval scope returns exactly the matching row", () => {
    service().approve({ ...baseInput, approvalScope: "spec" });
    service().approve(baseInput);
    // Unrelated action noise.
    actionLog.record({
      actionVerb: "annotate",
      qitemId: null,
      actorSession: "a@r",
      actedAt: new Date().toISOString(),
      annotation: "n",
    });
    const rows = auditBrowse.query({
      scopeTier: "slice",
      scopeId: "OPR.X.19",
      scopePath: "release-x/slices/19-signal-layer",
      approvalScope: "delivery",
      actorSession: "human-review@kernel",
    }).rows;
    expect(rows).toHaveLength(1);
    expect((rows[0]!.auditNotes as Record<string, unknown>).approval_scope).toBe("delivery");
  });

  it("hand-edited frontmatter with NO matching audit row: the cross-check query returns empty (the UNVERIFIED-stamp signal)", () => {
    fs.writeFileSync(readmePath, "---\nid: OPR.X.19\napproved-by: forged@nowhere\napproved-at: 2026-07-04T00:00:00Z\n---\n# s\n");
    const rows = auditBrowse.query({ scopeTier: "slice", scopeId: "OPR.X.19" }).rows;
    expect(rows).toHaveLength(0); // detectable from stored data alone
  });

  it("STAGED: --scope spec writes approved-spec-by/-at with approval_scope=spec; delivery afterwards is the normal staged sequence, not a re-stamp", () => {
    service().approve({ ...baseInput, approvalScope: "spec", actorSession: "pm-lead@openrig-pm" });
    let fm = frontmatterOf(readmePath);
    expect(fm["approved-spec-by"]).toBe("pm-lead@openrig-pm");
    expect(fm["approved-by"]).toBeUndefined();
    // Delivery stamp lands independently.
    service().approve(baseInput);
    fm = frontmatterOf(readmePath);
    expect(fm["approved-spec-by"]).toBe("pm-lead@openrig-pm");
    expect(fm["approved-by"]).toBe("human-review@kernel");
    const spec = auditBrowse.query({ scopeId: "OPR.X.19", approvalScope: "spec" }).rows;
    const delivery = auditBrowse.query({ scopeId: "OPR.X.19", approvalScope: "delivery" }).rows;
    expect(spec).toHaveLength(1);
    expect(delivery).toHaveLength(1);
  });

  it("re-approve at the SAME scope fails loudly naming the existing stamp", () => {
    service().approve(baseInput);
    expect(() => service().approve(baseInput)).toThrow(/already carries a delivery approval stamp/);
    try {
      service().approve(baseInput);
    } catch (err) {
      expect((err as ScopeApproveError).code).toBe("already_approved");
    }
    // Only ONE audit row exists.
    expect(auditBrowse.query({ scopeId: "OPR.X.19" }).rows).toHaveLength(1);
  });

  it("DELEGATED: --on-behalf-of keeps the REAL invoking session as actor; delegation lives in the audit notes", () => {
    service().approve({ ...baseInput, actorSession: "orch-advisor@openrig-delivery", onBehalfOf: "founder" });
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-by"]).toBe("orch-advisor@openrig-delivery"); // honest provenance
    const rows = auditBrowse.query({ scopeId: "OPR.X.19" }).rows;
    expect(rows[0]!.actorSession).toBe("orch-advisor@openrig-delivery");
    expect((rows[0]!.auditNotes as Record<string, unknown>).on_behalf_of).toBe("founder");
    expect(rows[0]!.reason).toContain("on behalf of founder");
  });

  it("mission-tier approve has the same semantics", () => {
    const missionReadme = path.join(missionsRoot, "release-x", "README.md");
    fs.writeFileSync(missionReadme, "---\nid: OPR.X\n---\n# mission\n");
    service().approve({ scopeTier: "mission", scopePath: "release-x", approvalScope: "delivery", actorSession: "human@kernel" });
    expect(frontmatterOf(missionReadme)["approved-by"]).toBe("human@kernel");
    const rows = auditBrowse.query({ scopeTier: "mission", scopeId: "OPR.X" }).rows;
    expect(rows).toHaveLength(1);
  });

  it("QA GUARDRAIL: an audit-write failure restores the prior frontmatter and fails loudly — no trusted half-stamp, no deleted audit rows", () => {
    const failingLog = {
      record: () => { throw new Error("disk full"); },
    } as unknown as MissionControlActionLog;
    const before = fs.readFileSync(readmePath, "utf8");
    expect(() => service({ actionLog: failingLog }).approve(baseInput)).toThrow(/no half-stamp/);
    // Frontmatter byte-restored.
    expect(fs.readFileSync(readmePath, "utf8")).toBe(before);
    expect(frontmatterOf(readmePath)["approved-by"]).toBeUndefined();
    // And the failure path never wrote (or deleted) audit rows.
    expect(auditBrowse.query({ scopeId: "OPR.X.19" }).rows).toHaveLength(0);
  });

  it("guards: path escape, missing README, missing dot-ID", () => {
    expect(() => service().approve({ ...baseInput, scopePath: "../../etc" })).toThrow(ScopeApproveError);
    expect(() => service().approve({ ...baseInput, scopePath: "release-x/slices/nope" })).toThrow(/not a declared slice/);
    fs.writeFileSync(readmePath, "---\nstatus: building\n---\n# no id\n");
    expect(() => service().approve(baseInput)).toThrow(/no frontmatter id/);
  });

  // ===================================================================
  // STAGE-3 LEVER A — plan-lock snapshot (collecting REDs + gate GREEN pins)
  // REV4 348f84f3 §4/§6. TEST-ONLY: RED-1..5 fail because `locked-artifacts` is
  // ABSENT (the plan-lock writer is unbuilt); they become regression pins when the
  // writer lands in a SEPARATE Guard-gated GREEN dispatch. Every assertion runs
  // through the shipped ScopeApproveService + gather/compose — no unbuilt-module
  // import. The companion GREEN pins hold pre- AND post-writer (they lock the gate).
  // Expected shapes authored per §3 derivation (PRD -> selected proof-contract
  // plannedRefs -> intent visuals; normalized-path dedup; escape/N-A excluded).
  // ===================================================================

  const specInput = { ...baseInput, approvalScope: "spec" as const, actorSession: "pm-lead@openrig-pm" };
  const lockedOf = (p: string) => frontmatterOf(p)["locked-artifacts"] as Array<Record<string, unknown>> | undefined;
  // The always-pinned PRD spec entry (§3.1) — the EXPECTED spec path even when the PRD is missing/unreadable.
  const PRD = { name: "Implementation PRD", path: "IMPLEMENTATION-PRD.md", kind: "spec" };

  it("RED-1 slice-spec: locked-artifacts = the exact ordered 4-object array (PRD + 2 proof-contract mockups + 1 intent visual) (fails: key absent)", () => {
    fs.writeFileSync(
      readmePath,
      "---\nid: OPR.X.19\nstatus: building\n---\n\n# The slice\n\n## Intent visual\n\n![the landing](mockups/landing.png)\n\nbody\n",
    );
    fs.writeFileSync(
      path.join(sliceDir, "IMPLEMENTATION-PRD.md"),
      "---\ntitle: prd\n---\n\n# Spec\n\n## Proof contract\n\n- [ ] drawer opens ![drawer](mockups/drawer.png)\n- [ ] row hit target ![row](mockups/row.png)\n",
    );
    service().approve(specInput); // slice-spec approve succeeds + stamps
    const locked = lockedOf(readmePath);
    expect(locked).toBeDefined(); // <-- RED: locked-artifacts absent (writer unbuilt)
    // Full ordered objects: PRD spec -> selected proof-contract plannedRefs (name=item text) -> intent visual (name=path).
    expect(locked).toEqual([
      PRD,
      { name: "drawer opens", path: "mockups/drawer.png", kind: "mockup" },
      { name: "row hit target", path: "mockups/row.png", kind: "mockup" },
      { name: "mockups/landing.png", path: "mockups/landing.png", kind: "mockup" },
    ]);
  });

  it("RED-2 compose parity: the written slice through gather+compose renders the EXACT ordered plan.lockedArtifacts (fails: empty)", () => {
    const ws = makeFixtureWorkspace();
    const gdb = createDb();
    try {
      migrate(gdb, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema, queueTransitionsSchema, missionControlActionsSchema, queueItemSummarySchema]);
      writeFixtureSlice(ws, "release-y", "20-plan", {
        id: "OPR.Y.20",
        intent: "founder words",
        prd: { proofContract: ["drawer opens ![drawer](mockups/drawer.png)"] },
      });
      new ScopeApproveService({ missionsRoot: () => ws.root, actionLog: new MissionControlActionLog(gdb) })
        .approve({ scopeTier: "slice", scopePath: "release-y/slices/20-plan", approvalScope: "spec", actorSession: "pm-lead@openrig-pm" });
      const indexer = new SliceIndexer({ slicesRoot: ws.root, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db: gdb });
      const gatherer = new ReviewGatherer({ db: gdb, indexer, gitRepoPath: null, now: () => "2026-07-23T00:00:00.000Z" });
      const composed = gatherer.composeSlice("20-plan");
      expect(composed).not.toBeNull();
      const locked = composed!.plan.lockedArtifacts;
      expect(locked.length).toBeGreaterThan(0); // <-- RED: empty (approve wrote no locked-artifacts)
      // The intent lives under `## Intent` (not `## Intent visual`), so only PRD + the proof-contract mockup.
      expect(locked).toEqual([PRD, { name: "drawer opens", path: "mockups/drawer.png", kind: "mockup" }]);
    } finally {
      gdb.close();
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });

  it("RED-3a PRD-only: a slice-spec approve with a PRD but no mockups pins the exact singleton [Implementation PRD] (fails: absent)", () => {
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "---\ntitle: prd\n---\n\n# Spec\n\nno mockups here\n");
    service().approve(specInput);
    const locked = lockedOf(readmePath);
    expect(locked).toBeDefined(); // <-- RED: absent
    expect(locked).toEqual([PRD]);
  });

  it("RED-3b missing-PRD fail-open: slice-spec approve SUCCEEDS with no IMPLEMENTATION-PRD.md and pins the exact singleton [Implementation PRD] (fails: absent)", () => {
    // no IMPLEMENTATION-PRD.md — approve must not throw/500 (Guard #4 fail-open).
    expect(() => service().approve(specInput)).not.toThrow();
    expect(frontmatterOf(readmePath)["approved-spec-by"]).toBe("pm-lead@openrig-pm"); // stamp landed
    const locked = lockedOf(readmePath);
    expect(locked).toBeDefined(); // <-- RED: absent (writer unbuilt)
    expect(locked).toEqual([PRD]);
  });

  it("RED-3c unreadable-PRD fail-open: IMPLEMENTATION-PRD.md as a DIRECTORY (EISDIR) still approves and pins the exact singleton [Implementation PRD] (fails: absent)", () => {
    fs.mkdirSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md")); // deterministic unreadable-as-file (EISDIR)
    expect(() => service().approve(specInput)).not.toThrow();
    expect(frontmatterOf(readmePath)["approved-spec-by"]).toBe("pm-lead@openrig-pm"); // stamp landed
    const locked = lockedOf(readmePath);
    expect(locked).toBeDefined(); // <-- RED: absent
    expect(locked).toEqual([PRD]);
  });

  it("RED-4 README-wins selected-source parity: an authored README proof-contract over a PRISTINE-scaffold PRD yields the exact [PRD, authored README mockup] (fails: absent)", () => {
    fs.writeFileSync(
      readmePath,
      "---\nid: OPR.X.19\nstatus: building\n---\n\n# The slice\n\n## Proof contract\n\n- [ ] authored ![authored](mockups/authored.png)\n",
    );
    // PRISTINE-scaffold PRD proof-contract (bracket-wrapped placeholder) -> README wins; the PRD scaffold contributes NOTHING.
    fs.writeFileSync(
      path.join(sliceDir, "IMPLEMENTATION-PRD.md"),
      "---\ntitle: prd\n---\n\n# Spec\n\n## Proof contract\n\n- [ ] [what will you show]\n",
    );
    service().approve(specInput);
    const locked = lockedOf(readmePath);
    expect(locked).toBeDefined(); // <-- RED: absent
    expect(locked).toEqual([PRD, { name: "authored", path: "mockups/authored.png", kind: "mockup" }]);
  });

  it("RED-5 URL-scheme + escape + absolute reject, N/A-with-image suppress, normalized first-wins dedup, exact order + determinism (fails: absent)", () => {
    // Intent visual body CONTAINS N/A alongside a real image -> the section is suppressed (the image must NOT appear).
    // Proof contract: normalization-distinct dup (mockups/./d.png then mockups/d.png) -> first-wins name; plus a URL
    // scheme plannedRef, /absolute, and ../escape — all three must be rejected (every locked path is slice-relative).
    const body =
      "---\nid: OPR.X.19\nstatus: building\n---\n\n# The slice\n\n## Intent visual\n\nN/A ![shouldnotappear](mockups/skip.png)\n";
    const prd =
      "---\ntitle: prd\n---\n\n# Spec\n\n## Proof contract\n\n- [ ] alpha ![a](mockups/./d.png)\n- [ ] beta ![b](mockups/d.png)\n- [ ] abs ![c](/absolute.png)\n- [ ] esc ![e](../secret.png)\n- [ ] external ![ext](https://example.invalid/external.png)\n";
    fs.writeFileSync(readmePath, body);
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), prd);
    service().approve(specInput);
    // A second, INDEPENDENTLY created slice with IDENTICAL derivation input (determinism).
    const dirB = path.join(missionsRoot, "release-x", "slices", "19d-plan");
    fs.mkdirSync(dirB, { recursive: true });
    const readmeB = path.join(dirB, "README.md");
    fs.writeFileSync(readmeB, body);
    fs.writeFileSync(path.join(dirB, "IMPLEMENTATION-PRD.md"), prd);
    service().approve({ ...specInput, scopePath: "release-x/slices/19d-plan" });

    const locked = lockedOf(readmePath);
    expect(locked).toBeDefined(); // <-- RED: absent
    // /absolute.png + ../secret.png rejected; N/A section (skip.png) suppressed; mockups/./d.png normalized to
    // mockups/d.png and first-wins (name "alpha", NOT the deduped "beta"); PRD first.
    expect(locked).toEqual([PRD, { name: "alpha", path: "mockups/d.png", kind: "mockup" }]);
    expect(lockedOf(readmeB)).toEqual(locked); // determinism: identical input -> identical ordered array
  });

  // ---- Companion GREEN pins (hold pre- AND post-writer: they lock the gate) ----

  it("GREEN gate — mission-spec approve NEVER creates locked-artifacts", () => {
    const missionReadme = path.join(missionsRoot, "release-x", "README.md");
    fs.writeFileSync(missionReadme, "---\nid: OPR.X\n---\n# mission\n");
    service().approve({ scopeTier: "mission", scopePath: "release-x", approvalScope: "spec", actorSession: "pm-lead@openrig-pm" });
    expect(frontmatterOf(missionReadme)["locked-artifacts"]).toBeUndefined();
  });

  it("GREEN gate — a fresh slice DELIVERY approve NEVER creates locked-artifacts", () => {
    service().approve(baseInput); // delivery
    expect(frontmatterOf(readmePath)["locked-artifacts"]).toBeUndefined();
  });

  it("GREEN gate — spec-then-delivery PRESERVES the EXACT existing locked-artifacts list verbatim (merge keeps it)", () => {
    // A concrete ordered multi-entry list with distinct names/paths/kinds so the
    // assertion proves EXACT preservation (order + every field + count), not just
    // a partial/first-entry match.
    fs.writeFileSync(
      readmePath,
      "---\nid: OPR.X.19\nstatus: building\n" +
        "locked-artifacts:\n" +
        "  - name: Implementation PRD\n    path: IMPLEMENTATION-PRD.md\n    kind: spec\n" +
        "  - name: drawer opens right\n    path: mockups/drawer.png\n    kind: mockup\n" +
        "  - name: intent shot\n    path: proof/intent.png\n    kind: intent\n" +
        "---\n# s\n",
    );
    service().approve(baseInput); // delivery approve merges the stamp, keeps locked-artifacts untouched
    expect(lockedOf(readmePath)).toEqual([
      { name: "Implementation PRD", path: "IMPLEMENTATION-PRD.md", kind: "spec" },
      { name: "drawer opens right", path: "mockups/drawer.png", kind: "mockup" },
      { name: "intent shot", path: "proof/intent.png", kind: "intent" },
    ]);
  });

  it("GREEN gate — a slice-spec audit failure restores the VERBATIM original README and writes zero action rows", () => {
    const failingLog = { record: () => { throw new Error("disk full"); } } as unknown as MissionControlActionLog;
    const before = fs.readFileSync(readmePath, "utf8");
    expect(() => service({ actionLog: failingLog }).approve(specInput)).toThrow(/no half-stamp/);
    expect(fs.readFileSync(readmePath, "utf8")).toBe(before);
    expect(frontmatterOf(readmePath)["approved-spec-by"]).toBeUndefined();
    expect(auditBrowse.query({ scopeId: "OPR.X.19" }).rows).toHaveLength(0);
  });
});
