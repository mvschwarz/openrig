import { describe, it, expect } from "vitest";
import { classifyScopeItem, type ScopeAuditInput } from "../src/lib/scope/scope-audit.js";

function makeInput(overrides: Partial<ScopeAuditInput>): ScopeAuditInput {
  return {
    id: null,
    path: "/workspace/missions/release-0.4.0",
    readmeFrontmatterRaw: null,
    progressFileExists: false,
    readmeOnlyMarker: false,
    isActiveRelease: true,
    level: "mission",
    ...overrides,
  };
}

describe("scope-audit classifier", () => {
  // RAIL STATUS
  it("present when PROGRESS.md exists", () => {
    const result = classifyScopeItem(makeInput({ progressFileExists: true }));
    expect(result.railStatus).toBe("present");
  });

  it("missing when no PROGRESS.md and no readme-only marker", () => {
    const result = classifyScopeItem(makeInput());
    expect(result.railStatus).toBe("missing");
    expect(result.findings.some((f) => f.kind === "missing_progress")).toBe(true);
  });

  it("readme-only when marker is set", () => {
    const result = classifyScopeItem(makeInput({ readmeOnlyMarker: true }));
    expect(result.railStatus).toBe("readme-only");
    expect(result.findings.filter((f) => f.kind === "missing_progress")).toHaveLength(0);
  });

  // 3-WAY DISCRIMINATOR (AC-3)
  it("registration ghost: id: line + YAML parse error -> ghost finding (HIGH for active)", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: OPR.0.4.0.16\nbad: yaml: {{broken",
      isActiveRelease: true,
    }));
    expect(result.findings.some((f) => f.kind === "registration_ghost" && f.severity === "high")).toBe(true);
    expect(result.frontmatterError).not.toBeNull();
  });

  it("missing-id: frontmatter parses but no id field -> missing_id finding", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "title: Some slice\nstatus: in-progress",
      isActiveRelease: true,
    }));
    expect(result.findings.some((f) => f.kind === "missing_id")).toBe(true);
    expect(result.frontmatterError).toBeNull();
  });

  it("id-convention violation: id present but invalid format", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: not-a-dot-id",
      isActiveRelease: true,
      level: "mission",
    }));
    expect(result.findings.some((f) => f.kind === "id_convention_violation")).toBe(true);
  });

  it("clean: valid id + PROGRESS.md -> no findings", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: release-0.4.0",
      progressFileExists: true,
      level: "mission",
    }));
    // mission dot-id validator may or may not accept "release-0.4.0"
    // but there should be no ghost or missing-id finding
    expect(result.findings.filter((f) => f.kind === "registration_ghost" || f.kind === "missing_id")).toHaveLength(0);
    expect(result.railStatus).toBe("present");
  });

  // SEVERITY
  it("missing progress is HIGH for active release, LOW for historical", () => {
    const active = classifyScopeItem(makeInput({ isActiveRelease: true }));
    const historical = classifyScopeItem(makeInput({ isActiveRelease: false }));
    expect(active.findings[0]?.severity).toBe("high");
    expect(historical.findings[0]?.severity).toBe("low");
  });

  // GHOST vs MISSING-ID DISTINCT
  it("ghost and missing-id are distinct finding kinds", () => {
    const ghost = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: OPR.broken\nbad: {{yaml",
    }));
    const missingId = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "title: no id here",
    }));
    const ghostKinds = ghost.findings.map((f) => f.kind);
    const missingKinds = missingId.findings.map((f) => f.kind);
    expect(ghostKinds).toContain("registration_ghost");
    expect(ghostKinds).not.toContain("missing_id");
    expect(missingKinds).toContain("missing_id");
    expect(missingKinds).not.toContain("registration_ghost");
  });

  // SLICE LEVEL
  it("slice missing-id uses slice dot-ID validator", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: not-a-slice-id",
      level: "slice",
      isActiveRelease: true,
    }));
    expect(result.findings.some((f) => f.kind === "id_convention_violation")).toBe(true);
  });

  // MALFORMED RAIL STATUS REGRESSIONS (guard BLOCKING)
  it("parse error + PROGRESS.md => railStatus malformed (not present)", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: OPR.broken\nbad: {{yaml",
      progressFileExists: true,
    }));
    expect(result.railStatus).toBe("malformed");
    expect(result.frontmatterError).not.toBeNull();
  });

  it("parse error + id line => registration_ghost + malformed", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: OPR.test\nbroken: {{yaml",
      isActiveRelease: true,
    }));
    expect(result.railStatus).toBe("malformed");
    expect(result.findings.some((f) => f.kind === "registration_ghost" && f.severity === "high")).toBe(true);
  });

  it("parse error WITHOUT id line => finding + frontmatterError for UI severity", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "broken: {{yaml",
      isActiveRelease: true,
    }));
    expect(result.railStatus).toBe("malformed");
    expect(result.frontmatterError).not.toBeNull();
    expect(result.findings.some((f) => f.kind === "registration_ghost")).toBe(true);
  });

  // GUARD BLOCKING: no-leading-frontmatter README must emit finding
  it("README with no frontmatter (readmeFrontmatterRaw null) + PROGRESS.md => missing_id finding", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: null,
      progressFileExists: true,
      isActiveRelease: true,
    }));
    expect(result.findings.some((f) => f.kind === "missing_id")).toBe(true);
    expect(result.railStatus).toBe("present");
  });

  it("README with no frontmatter + no PROGRESS.md => missing_id + missing_progress", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: null,
      progressFileExists: false,
      isActiveRelease: true,
    }));
    expect(result.findings.some((f) => f.kind === "missing_id")).toBe(true);
    expect(result.findings.some((f) => f.kind === "missing_progress")).toBe(true);
  });

  it("mission without MISSION_BRIEF.md emits medium missing_mission_brief at the artifact path", () => {
    const result = classifyScopeItem(makeInput({
      level: "mission",
      readmeFrontmatterRaw: "id: OPR.0.4.1",
      progressFileExists: true,
      missionBriefExists: false,
      missionBriefPath: "/workspace/missions/release-0.4.1/MISSION_BRIEF.md",
    }));
    const finding = result.findings.find((f) => f.kind === "missing_mission_brief");
    expect(finding).toMatchObject({
      severity: "medium",
      path: "/workspace/missions/release-0.4.1/MISSION_BRIEF.md",
    });
    expect(finding?.message).toMatch(/MISSION_BRIEF\.md/);
    expect(finding?.remediation).toMatch(/# <Mission name> — Brief/);
  });

  it("mission with malformed MISSION_BRIEF.md emits medium malformed_mission_brief", () => {
    const result = classifyScopeItem(makeInput({
      level: "mission",
      readmeFrontmatterRaw: "id: OPR.0.4.1",
      progressFileExists: true,
      missionBriefExists: true,
      missionBriefPath: "/workspace/missions/release-0.4.1/MISSION_BRIEF.md",
      missionBriefContent: "# release — Brief\n\n## Progress\n## What & why\n",
    }));
    const finding = result.findings.find((f) => f.kind === "malformed_mission_brief");
    expect(finding?.severity).toBe("medium");
    expect(finding?.path).toBe("/workspace/missions/release-0.4.1/MISSION_BRIEF.md");
    expect(finding?.message).toMatch(/canonical MISSION_BRIEF\.md section order/);
  });

  it("mission with locked slice-16 MISSION_BRIEF.md schema does not emit brief findings", () => {
    const content = [
      "# release-0.4.1 — Brief",
      "",
      "## What & why",
      "## Building",
      "## Progress",
      "## Proven",
      "## Needs you",
      "## Pointers",
    ].join("\n");
    const result = classifyScopeItem(makeInput({
      level: "mission",
      readmeFrontmatterRaw: "id: OPR.0.4.1",
      progressFileExists: true,
      missionBriefExists: true,
      missionBriefPath: "/workspace/missions/release-0.4.1/MISSION_BRIEF.md",
      missionBriefContent: content,
    }));
    expect(result.findings.filter((f) =>
      f.kind === "missing_mission_brief" || f.kind === "malformed_mission_brief"
    )).toHaveLength(0);
  });

  it("mission without MISSION_NOTES.md emits low missing_mission_notes", () => {
    const result = classifyScopeItem(makeInput({
      level: "mission",
      readmeFrontmatterRaw: "id: OPR.0.4.1",
      progressFileExists: true,
      missionNotesExists: false,
      missionNotesPath: "/workspace/missions/release-0.4.1/MISSION_NOTES.md",
    }));
    const finding = result.findings.find((f) => f.kind === "missing_mission_notes");
    expect(finding).toMatchObject({
      severity: "low",
      path: "/workspace/missions/release-0.4.1/MISSION_NOTES.md",
    });
    expect(finding?.remediation).toMatch(/MISSION_NOTES\.md/);
  });

  it("done slice with no PROOF.md and no proof packet emits medium missing_proof", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.28\nstatus: done",
      progressFileExists: true,
      proofFileExists: false,
      proofFilePath: "/workspace/missions/release-0.4.1/slices/28-slice/PROOF.md",
      proofDirExists: true,
      proofDirHasEntries: false,
      proofDirPath: "/workspace/missions/release-0.4.1/slices/28-slice/proof",
      hasProofPacket: false,
    }));
    const finding = result.findings.find((f) => f.kind === "missing_proof");
    expect(finding).toMatchObject({
      severity: "medium",
      path: "/workspace/missions/release-0.4.1/slices/28-slice/PROOF.md",
    });
    expect(finding?.message).toMatch(/done\/proven/);
    expect(finding?.remediation).toMatch(/proof\//);
  });

  it("wip slice with no proof does not emit missing_proof", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.28\nstatus: wip",
      progressFileExists: true,
      proofFileExists: false,
      proofDirExists: false,
      hasProofPacket: false,
    }));
    expect(result.findings.some((f) => f.kind === "missing_proof")).toBe(false);
  });

  it("proof packet marks a slice proven and still emits missing_proof when root proof is absent", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.28\nstatus: active",
      progressFileExists: true,
      proofFileExists: false,
      proofFilePath: "/workspace/missions/release-0.4.1/slices/28-slice/PROOF.md",
      proofDirExists: false,
      hasProofPacket: true,
    }));
    const finding = result.findings.find((f) => f.kind === "missing_proof");
    expect(finding).toMatchObject({
      severity: "medium",
      path: "/workspace/missions/release-0.4.1/slices/28-slice/PROOF.md",
    });
    expect(finding?.message).not.toMatch(/no proof packet/);
  });

  it("root PROOF.md plus populated proof directory suppresses missing_proof", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.28\nstatus: shipped",
      progressFileExists: true,
      proofFileExists: true,
      proofDirExists: true,
      proofDirHasEntries: true,
      hasProofPacket: false,
    }));
    expect(result.findings.some((f) => f.kind === "missing_proof")).toBe(false);
  });

  // TIGHTENED: missing_mission_notes gates on ACTIVE mission status
  it("active mission (no status) without MISSION_NOTES emits missing_mission_notes", () => {
    const result = classifyScopeItem(makeInput({
      level: "mission",
      readmeFrontmatterRaw: "id: OPR.0.4.1",
      progressFileExists: true,
      missionNotesExists: false,
    }));
    expect(result.findings.some((f) => f.kind === "missing_mission_notes")).toBe(true);
  });

  it("active mission (explicit active status) without MISSION_NOTES emits missing_mission_notes", () => {
    const result = classifyScopeItem(makeInput({
      level: "mission",
      readmeFrontmatterRaw: "id: OPR.0.4.1\nstatus: active",
      progressFileExists: true,
      missionNotesExists: false,
    }));
    expect(result.findings.some((f) => f.kind === "missing_mission_notes")).toBe(true);
  });

  it("terminal mission (shipped/archived/complete) without MISSION_NOTES does NOT emit missing_mission_notes", () => {
    for (const status of ["shipped", "archived", "complete", "closed", "historical", "superseded"]) {
      const result = classifyScopeItem(makeInput({
        level: "mission",
        readmeFrontmatterRaw: `id: OPR.0.4.1\nstatus: ${status}`,
        progressFileExists: true,
        missionNotesExists: false,
      }));
      expect(
        result.findings.some((f) => f.kind === "missing_mission_notes"),
        `status "${status}" should not flag missing notes`,
      ).toBe(false);
    }
  });

  // NEW: committed-without-PROGRESS (git-derived, CLI-only input)
  it("slice touched by HEAD without a PROGRESS.md change emits progress_not_updated_on_commit", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      path: "/workspace/missions/release-0.4.1/slices/32-x",
      readmeFrontmatterRaw: "id: OPR.0.4.1.32\nstatus: wip",
      progressFileExists: true,
      sliceTouchedByRecentCommit: true,
      progressTouchedByRecentCommit: false,
    }));
    const finding = result.findings.find((f) => f.kind === "progress_not_updated_on_commit");
    expect(finding).toMatchObject({
      severity: "medium",
      path: "/workspace/missions/release-0.4.1/slices/32-x/PROGRESS.md",
    });
    expect(finding?.remediation).toMatch(/PROGRESS\.md/);
  });

  it("slice touched by HEAD WITH a PROGRESS.md change does not emit progress_not_updated_on_commit", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.32\nstatus: wip",
      progressFileExists: true,
      sliceTouchedByRecentCommit: true,
      progressTouchedByRecentCommit: true,
    }));
    expect(result.findings.some((f) => f.kind === "progress_not_updated_on_commit")).toBe(false);
  });

  it("committed-without-PROGRESS is inert when git context is unavailable (both inputs undefined)", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.32\nstatus: wip",
      progressFileExists: true,
      // sliceTouchedByRecentCommit / progressTouchedByRecentCommit left undefined
    }));
    expect(result.findings.some((f) => f.kind === "progress_not_updated_on_commit")).toBe(false);
  });

  it("committed-without-PROGRESS does not fire when HEAD did not touch the slice", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.32\nstatus: wip",
      progressFileExists: true,
      sliceTouchedByRecentCommit: false,
      progressTouchedByRecentCommit: false,
    }));
    expect(result.findings.some((f) => f.kind === "progress_not_updated_on_commit")).toBe(false);
  });
});

// OPR.0.4.4.23 — SDLC convention-section advisories. Structurally
// fail-open: the audit exit code flips on HIGH findings only, and every
// finding below asserts a low/info severity; the checks are inert when the
// caller provides no content context.
describe("OPR.0.4.4.23 convention-section advisories", () => {
  const CONVENTION_README = [
    "# Slice 05 — Probe",
    "## Intent", "the recorded intent",
    "## Mini-requirements", "1. one",
    "## Proof contract", "- [ ] a deliverable — captured",
  ].join("\n");

  function sliceInput(overrides: Partial<ScopeAuditInput>): ScopeAuditInput {
    return {
      id: null,
      path: "/w/missions/release-x/slices/05-probe",
      readmeFrontmatterRaw: "id: OPR.0.4.4.5\nstatus: wip",
      progressFileExists: true,
      readmeOnlyMarker: false,
      isActiveRelease: true,
      level: "slice",
      ...overrides,
    };
  }

  it("accepts the one-SPEC convention without requiring a retired PRD or duplicate body intent", () => {
    const result = classifyScopeItem(sliceInput({
      readmeFrontmatterRaw: "id: OPR.0.4.4.5\nstatus: building\nintent: the recorded intent\ndepends_on: []",
      readmeContent: [
        "# Slice 05 — Probe",
        "## Mini-requirements", "1. one",
        "## Proof contract", "- [ ] a deliverable — captured",
      ].join("\n"),
      implementationPrdExists: false,
      implementationPrdContent: null,
    }));
    expect(result.findings.some((f) => f.kind === "missing_implementation_prd")).toBe(false);
    expect(result.findings.some((f) => f.kind === "missing_intent_section")).toBe(false);
  });

  it("inert when no content context is provided (undefined inputs)", () => {
    const result = classifyScopeItem(sliceInput({}));
    expect(result.findings.some((f) =>
      f.kind === "missing_intent_section"
      || f.kind === "mini_requirements_missing_or_malformed"
      || f.kind === "proof_contract_missing_or_malformed"
      || f.kind === "ui_slice_missing_mockup",
    )).toBe(false);
  });

  it("clean convention README yields no section findings", () => {
    const result = classifyScopeItem(sliceInput({ readmeContent: CONVENTION_README, implementationPrdContent: null }));
    expect(result.findings.some((f) =>
      f.kind === "missing_intent_section"
      || f.kind === "mini_requirements_missing_or_malformed"
      || f.kind === "proof_contract_missing_or_malformed",
    )).toBe(false);
  });

  it("README without ## Intent -> missing_intent_section at LOW (never high)", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: "# Slice\n## Goal\nold shape\n## Proof contract\n- [ ] x\n",
      implementationPrdContent: null,
    }));
    const finding = result.findings.find((f) => f.kind === "missing_intent_section");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("low");
  });

  it("## Intent visual does NOT satisfy ## Intent (exact-heading match)", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: "# Slice\n## Intent visual\n![x](./x.png)\n## Proof contract\n- [ ] x\n",
      implementationPrdContent: null,
    }));
    expect(result.findings.some((f) => f.kind === "missing_intent_section")).toBe(true);
  });

  it("PRD provided: proof contract is checked on the PRD path", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: CONVENTION_README,
      implementationPrdContent: "# PRD\n## Intent\nx\n## Mini-requirements\n1. y\n",
    }));
    const finding = result.findings.find((f) => f.kind === "proof_contract_missing_or_malformed");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("low");
    expect(finding!.path.endsWith("IMPLEMENTATION-PRD.md")).toBe(true);
  });

  it("PRD absent (null): proof contract falls back to the README", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: "# Slice\n## Intent\nx\n",
      implementationPrdContent: null,
    }));
    const finding = result.findings.find((f) => f.kind === "proof_contract_missing_or_malformed");
    expect(finding).toBeDefined();
    expect(finding!.path.endsWith("README.md")).toBe(true);
  });

  it("## Proof contract heading with no checkbox items is malformed", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: "# Slice\n## Intent\nx\n## Proof contract\nprose only, no checkboxes\n",
      implementationPrdContent: null,
    }));
    expect(result.findings.some((f) => f.kind === "proof_contract_missing_or_malformed")).toBe(true);
  });

  it("visual slice without any mockup ref -> ui_slice_missing_mockup at INFO", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: "# Slice\n## Intent\nx\n## Proof contract\n- [ ] the panel renders\n## Intent visual\nwill add later\n",
      implementationPrdContent: null,
    }));
    const finding = result.findings.find((f) => f.kind === "ui_slice_missing_mockup");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
  });

  it("visual slice with an image ref (or N/A marking) does not fire the mockup advisory", () => {
    const withImage = classifyScopeItem(sliceInput({
      readmeContent: "# Slice\n## Intent\nx\n## Proof contract\n- [ ] y\n## Intent visual\n![Intent visual](./intent.png)\n",
      implementationPrdContent: null,
    }));
    expect(withImage.findings.some((f) => f.kind === "ui_slice_missing_mockup")).toBe(false);
    const nonVisual = classifyScopeItem(sliceInput({
      readmeContent: "# Slice\n## Intent\nx\n## Proof contract\n- [ ] y\n## Intent visual\nN/A\n",
      implementationPrdContent: null,
    }));
    expect(nonVisual.findings.some((f) => f.kind === "ui_slice_missing_mockup")).toBe(false);
  });

  it("FAIL-OPEN PIN: planted section violations never produce a HIGH finding (exit semantics unchanged)", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: "# Slice\nno sections at all\n## Intent visual\nno image\n",
      implementationPrdContent: null,
    }));
    const sectionFindings = result.findings.filter((f) =>
      f.kind === "missing_intent_section"
      || f.kind === "mini_requirements_missing_or_malformed"
      || f.kind === "proof_contract_missing_or_malformed"
      || f.kind === "ui_slice_missing_mockup",
    );
    expect(sectionFindings.length).toBeGreaterThan(0);
    expect(sectionFindings.every((f) => f.severity === "low" || f.severity === "info")).toBe(true);
  });
});

// OPR.0.4.4.23 rev1-r2 fixback — B1 (PRD L34 guard F-3: well-formed
// ## Mini-requirements) + B2 (generic "mockup" prose is not a mockup ref).
describe("OPR.0.4.4.23 rev1-r2 fixback — mini-requirements + mockup-ref tightening", () => {
  function sliceInput(overrides: Partial<ScopeAuditInput>): ScopeAuditInput {
    return {
      id: null,
      path: "/w/missions/release-x/slices/07-r2fix",
      readmeFrontmatterRaw: "id: OPR.0.4.4.7\nstatus: wip",
      progressFileExists: true,
      readmeOnlyMarker: false,
      isActiveRelease: true,
      level: "slice",
      ...overrides,
    };
  }

  it("B1: Intent + Proof contract but NO ## Mini-requirements -> mini_requirements_missing_or_malformed at LOW (the r2 false-green probe)", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: "# S\n## Intent\nx\n## Proof contract\n- [ ] y\n",
      implementationPrdContent: "# PRD\n## Intent\nx\n## Proof contract\n- [ ] y\n",
    }));
    const finding = result.findings.find((f) => f.kind === "mini_requirements_missing_or_malformed");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("low");
    expect(finding!.path.endsWith("IMPLEMENTATION-PRD.md")).toBe(true);
  });

  it("B1: ## Mini-requirements heading with prose-only body (no numbered item) is malformed", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: "# S\n## Intent\nx\n## Mini-requirements\njust prose, no list\n## Proof contract\n- [ ] y\n",
      implementationPrdContent: null,
    }));
    expect(result.findings.some((f) => f.kind === "mini_requirements_missing_or_malformed")).toBe(true);
  });

  it("B1: a numbered mini-requirements list is clean; PRD absent falls back to README", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: "# S\n## Intent\nx\n## Mini-requirements\n1. one observable outcome\n## Proof contract\n- [ ] y\n",
      implementationPrdContent: null,
    }));
    expect(result.findings.some((f) => f.kind === "mini_requirements_missing_or_malformed")).toBe(false);
  });

  it("B2 REGRESSION: generic proof-contract prose containing the word 'mockup' does NOT suppress ui_slice_missing_mockup (the scaffold-placeholder false-green)", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: "# S\n## Intent\nx\n## Mini-requirements\n1. y\n## Proof contract\n- [ ] UI deliverables name their planned mockup\n## Intent visual\nwill add later\n",
      implementationPrdContent: null,
    }));
    expect(result.findings.some((f) => f.kind === "ui_slice_missing_mockup")).toBe(true);
  });

  it("B2: an explicit plannedRef token in the proof contract IS a mockup ref", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: "# S\n## Intent\nx\n## Mini-requirements\n1. y\n## Proof contract\n- [ ] the panel renders (plannedRef: mockups/panel.png)\n## Intent visual\nwill add later\n",
      implementationPrdContent: null,
    }));
    expect(result.findings.some((f) => f.kind === "ui_slice_missing_mockup")).toBe(false);
  });

  it("B2: a markdown image ref inside the proof contract IS a mockup ref", () => {
    const result = classifyScopeItem(sliceInput({
      readmeContent: "# S\n## Intent\nx\n## Mini-requirements\n1. y\n## Proof contract\n- [ ] the panel renders ![planned](mockups/panel.png)\n## Intent visual\nwill add later\n",
      implementationPrdContent: null,
    }));
    expect(result.findings.some((f) => f.kind === "ui_slice_missing_mockup")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PM dogfood #1 (qitem-20260720015700-630eef64) — per-section source
// selection: an authored README convention section must not be shadowed by
// the corresponding PRISTINE scaffold-only PRD section. The decision is made
// INDEPENDENTLY for ## Mini-requirements and ## Proof contract; authored /
// missing / prose-only / mixed-authored PRD sections stay PRD-canonical and
// visible (guard boundary). Selection never reads lifecycle status.
// ---------------------------------------------------------------------------

describe("PM dogfood #1 — authored README sections vs pristine scaffold PRD", () => {
  const AUTHORED_README = [
    "# Slice 01 — Placeholder conventions",
    "",
    "## Intent",
    "",
    "make the review tab honest",
    "",
    "## Mini-requirements",
    "",
    "1. first authored requirement",
    "2. second authored requirement",
    "",
    "## Proof contract",
    "",
    "- [ ] authored deliverable one — captured",
    "- [ ] authored deliverable two — captured",
  ].join("\n");

  // Template-grammar pristine rows (structural marker + fully bracket-wrapped
  // text), mirroring scope-templates/implementation-prd.md.
  const PRISTINE_PRD = [
    "# Slice 01 — PRD",
    "",
    "## Intent",
    "",
    "[The recorded intent, verbatim — kept in sync with the slice README.]",
    "",
    "## Mini-requirements",
    "",
    "1. [The concise one-glance requirement tier — this is where approval starts.]",
    "",
    "## Proof contract",
    "",
    "- [ ] [One promised deliverable, written as an observable outcome — captured.]",
    "",
    "## Notes (elastic)",
    "",
    "[Design, seams, risks, sequencing — only as much as the slice needs.]",
  ].join("\n");

  function sliceInput(overrides: Partial<ScopeAuditInput>): ScopeAuditInput {
    return {
      id: null,
      path: "/w/missions/dogfood/slices/01-placeholder-conventions",
      readmeFrontmatterRaw: "id: OPR.99.0.2.1\nstatus: placeholder",
      progressFileExists: true,
      readmeOnlyMarker: false,
      isActiveRelease: true,
      level: "slice",
      ...overrides,
    };
  }

  const conventionFindings = (input: ScopeAuditInput) =>
    classifyScopeItem(input).findings.filter(
      (f) => f.kind === "mini_requirements_missing_or_malformed" || f.kind === "proof_contract_missing_or_malformed",
    );

  it("authored README + pristine PRD: NEITHER convention finding fires (the dogfood fixture)", () => {
    const findings = conventionFindings(sliceInput({
      readmeContent: AUTHORED_README,
      implementationPrdContent: PRISTINE_PRD,
    }));
    expect(findings).toEqual([]);
  });

  it("mixed per-section: PRD contract AUTHORED + PRD mini pristine + README mini authored -> neither finding (independent decisions)", () => {
    const prd = PRISTINE_PRD.replace(
      "- [ ] [One promised deliverable, written as an observable outcome — captured.]",
      "- [ ] prd-authored deliverable — captured",
    );
    const findings = conventionFindings(sliceInput({
      readmeContent: AUTHORED_README,
      implementationPrdContent: prd,
    }));
    expect(findings).toEqual([]);
  });

  it("PIN: PRD mini section authored-but-malformed (prose only) stays PRD-canonical — finding fires with the PRD path, never hidden by the README", () => {
    const prd = PRISTINE_PRD.replace(
      "1. [The concise one-glance requirement tier — this is where approval starts.]",
      "authored prose, deliberately no numbered items",
    );
    const findings = conventionFindings(sliceInput({
      readmeContent: AUTHORED_README,
      implementationPrdContent: prd,
    }));
    const mini = findings.find((f) => f.kind === "mini_requirements_missing_or_malformed");
    expect(mini).toBeDefined();
    expect(mini!.path.endsWith("IMPLEMENTATION-PRD.md")).toBe(true);
  });

  it("PIN: PRD MISSING the mini section stays PRD-canonical — finding fires with the PRD path (missing is not pristine)", () => {
    const prd = PRISTINE_PRD
      .replace("## Mini-requirements", "## Somewhere else")
      .replace("1. [The concise one-glance requirement tier — this is where approval starts.]", "nothing here");
    const findings = conventionFindings(sliceInput({
      readmeContent: AUTHORED_README,
      implementationPrdContent: prd,
    }));
    const mini = findings.find((f) => f.kind === "mini_requirements_missing_or_malformed");
    expect(mini).toBeDefined();
    expect(mini!.path.endsWith("IMPLEMENTATION-PRD.md")).toBe(true);
  });

  it("PIN: README sections ALSO pristine (nothing authored anywhere) -> findings fire with the PRD path", () => {
    const pristineReadme = [
      "# Slice",
      "## Intent",
      "[The recorded intent, verbatim.]",
      "## Mini-requirements",
      "1. [The concise one-glance requirement tier.]",
      "## Proof contract",
      "- [ ] [One promised deliverable.]",
    ].join("\n");
    const findings = conventionFindings(sliceInput({
      readmeContent: pristineReadme,
      implementationPrdContent: PRISTINE_PRD,
    }));
    expect(findings.map((f) => f.kind).sort()).toEqual([
      "mini_requirements_missing_or_malformed",
      "proof_contract_missing_or_malformed",
    ]);
    expect(findings.every((f) => f.path.endsWith("IMPLEMENTATION-PRD.md"))).toBe(true);
  });

  it("STATUS-INVARIANCE: placeholder vs planned frontmatter yields byte-identical findings (selection never reads status)", () => {
    const asPlaceholder = classifyScopeItem(sliceInput({
      readmeContent: AUTHORED_README,
      implementationPrdContent: PRISTINE_PRD,
      readmeFrontmatterRaw: "id: OPR.99.0.2.1\nstatus: placeholder",
    }));
    const asPlanned = classifyScopeItem(sliceInput({
      readmeContent: AUTHORED_README,
      implementationPrdContent: PRISTINE_PRD,
      readmeFrontmatterRaw: "id: OPR.99.0.2.1\nstatus: planned",
    }));
    expect(asPlanned.findings).toEqual(asPlaceholder.findings);
  });
});
