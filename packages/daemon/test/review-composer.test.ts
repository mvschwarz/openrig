// Living Notes — composer core ACs (OPR.0.4.4.20, rebuilt per the
// CORRECTIVE REDESIGN of 2026-07-05).
//
// Every test here is a spec acceptance criterion, driven against the PURE
// composer with hand-built inputs (idempotence is byte-equality on the
// serialized output — same inputs, same bytes). The one-structure contract
// is itself under test: the superseded structures (sections / acceptance /
// compare / join / green) must be ABSENT from the composed output.

import { describe, it, expect } from "vitest";
import {
  composeDelivered,
  composeLineage,
  composeMissionReview,
  composeRecordedGreenForSlice,
  composeSliceReview,
  computeRecordedGreen,
  deriveCandidateSha,
  deriveGateCells,
  derivePhase,
  extractMediaRefs,
  extractMiniReqs,
  extractProofContract,
  extractSection,
  isPassing,
  parseC1Header,
  proofClaimsPass,
  sliceRelativeMediaPath,
  type MissionSliceEntry,
  type SliceComposeInputs,
} from "../src/domain/review/compose.js";
import type { ProofArtifact } from "../src/domain/review/types.js";

const NOW = "2026-07-04T10:00:00.000Z";

function artifact(over: Partial<ProofArtifact> & { artifactType: ProofArtifact["artifactType"] }): ProofArtifact {
  return {
    relPath: `proof/${over.artifactType}.md`,
    slice: "s-20",
    candidateSha: "cand1234",
    verdict: null,
    moneyEvidence: null,
    evidences: [],
    selfCheck: null,
    mediaRefs: [],
    droppedAt: "2026-07-04T09:00:00.000Z",
    ...over,
  };
}

function fullGate(overrides: Partial<Record<"guard" | "qa" | "rev1-r1" | "rev1-r2", ProofArtifact["verdict"] | undefined>> = {}): ProofArtifact[] {
  const base = { guard: "CLEAR", qa: "PASS", "rev1-r1": "CLEAR", "rev1-r2": "CLEAR" } as const;
  return (Object.keys(base) as Array<keyof typeof base>)
    .filter((r) => overrides[r] !== undefined ? overrides[r] !== null : true)
    .map((r) => artifact({ artifactType: r, verdict: (r in overrides ? overrides[r] : base[r]) as ProofArtifact["verdict"] }));
}

function baseInputs(over: Partial<SliceComposeInputs> = {}): SliceComposeInputs {
  return {
    slice: { name: "20-fixture", id: "OPR.T.20", title: "Fixture slice", missionId: "release-t" },
    readme: "---\ntitle: t\n---\n\n# Fixture\n\n## Intent\n\nThe founder's exact words.\n",
    prd: "---\ntitle: t\n---\n\n## Mini-requirements\n\n1. One surface.\n2. Verified from recorded QA comparisons only.\n\n# Spec\n\nBody.\n\n## Proof contract\n\n- [ ] phone journey video\n- [ ] range probe 206\n",
    proofMd: null,
    artifacts: [],
    lockedArtifacts: [],
    mediaRefs: [],
    proofDirExists: true,
    attention: [],
    agents: [],
    activeQitemPresent: false,
    git: { mainTip: "tip99999", mergeSha: null, mergeIsAncestorOfTip: null, candidateBehindTip: 0 },
    approval: { spec: null, delivery: null },
    nowIso: NOW,
    ...over,
  };
}

const DELIVERY_STAMP = { by: "human@host", at: NOW, auditRowPresent: true };

describe("the ONE structure (§3.1) — no superseded structure survives", () => {
  it("composes exactly intent/plan/delivered — sections/acceptance/compare/join/green are ABSENT keys", () => {
    const r = composeSliceReview(baseInputs({ artifacts: fullGate() })) as unknown as Record<string, unknown>;
    for (const dead of ["sections", "acceptance", "compare", "join", "green", "locked"]) {
      expect(r, `superseded structure '${dead}' must not survive on the contract`).not.toHaveProperty(dead);
    }
    for (const alive of ["intent", "plan", "delivered", "needsYou", "agents", "lineage", "defects", "composedAt"]) {
      expect(r).toHaveProperty(alive);
    }
  });

  it("every section always composes, degrading honestly when its source is absent", () => {
    const r = composeSliceReview(baseInputs({ readme: null, prd: null }));
    expect(r.intent.text).toBeNull();
    expect(r.intent.degrade).toBe("no intent recorded");
    expect(r.intent.ssotPath).toBeNull();
    expect(r.plan.concise.text).toBeNull();
    expect(r.plan.ssotPath).toBeNull();
    expect(r.delivered.items).toHaveLength(0);
  });
});

describe("C1 header parsing", () => {
  it("parses a full header and treats out-of-set verdicts as null (present != verdict)", () => {
    const good = parseC1Header(
      "---\nslice: s-20\ncandidate_sha: abc123\nartifact_type: qa\nverdict: PASS\nmoney_evidence: one line\nevidences:\n  - 1\nself_check: looked at it\n---\nbody",
      "proof/qa.md",
      NOW,
    );
    expect(good.artifactType).toBe("qa");
    expect(good.verdict).toBe("PASS");
    expect(good.evidences).toEqual(["1"]);
    const bad = parseC1Header(
      "---\nslice: s\ncandidate_sha: abc\nartifact_type: qa\nverdict: PASSED\n---\n",
      "proof/qa.md",
      NOW,
    );
    expect(bad.verdict).toBeNull();
    const invalid = parseC1Header("no frontmatter at all", "proof/x.md", NOW);
    expect(invalid.artifactType).toBeNull();
  });

  it("captures body media refs (markdown images + video tags), excluding http", () => {
    const a = parseC1Header(
      '---\nartifact_type: qa\nverdict: PASS\n---\n\n![shot](drawer-right.png)\n<video src="playing.webm"></video>\n![ext](https://x/y.png)\n',
      "proof/qa.md",
      NOW,
    );
    expect(a.mediaRefs).toEqual(["drawer-right.png", "playing.webm"]);
  });
});

describe("FR-2 — pass-mapping + recorded verdicts", () => {
  it("pins the verdict pass-mapping exactly", () => {
    expect(isPassing("guard", "CLEAR")).toBe(true);
    expect(isPassing("guard", "PASS")).toBe(false);
    expect(isPassing("qa", "PASS")).toBe(true);
    expect(isPassing("qa", "CLEAR")).toBe(false);
    expect(isPassing("adjudication", "CLEAR")).toBe(true);
    expect(isPassing("adjudication", "PASS")).toBe(true);
    for (const t of ["guard", "qa", "rev1-r1", "rev1-r2", "adjudication"] as const) {
      expect(isPassing(t, "BLOCKING")).toBe(false);
      expect(isPassing(t, "CONCERNING")).toBe(false);
      expect(isPassing(t, "NOT-CLEAR")).toBe(false);
      expect(isPassing(t, null)).toBe(false);
    }
  });

  it("recorded green (mission-ledger fact): regime 1 from four passing verdicts, regime 2 from adjudication", () => {
    expect(composeRecordedGreenForSlice(fullGate())).toEqual({ green: true, regime: 1 });
    const adj = artifact({ artifactType: "adjudication", verdict: "CLEAR", relPath: "proof/adjudication.md" });
    expect(composeRecordedGreenForSlice([adj])).toEqual({ green: true, regime: 2 });
    expect(composeRecordedGreenForSlice(fullGate({ "rev1-r2": "CONCERNING" }))).toEqual({ green: false, regime: null });
    expect(composeRecordedGreenForSlice([])).toEqual({ green: false, regime: null });
  });

  it("one gate artifact absent -> the specific cell is missing", () => {
    const arts = fullGate().filter((a) => a.artifactType !== "rev1-r2");
    const r = composeSliceReview(baseInputs({ artifacts: arts }));
    const cell = r.lineage.gateCells.find((c) => c.role === "rev1-r2")!;
    expect(cell.state).toBe("missing");
    expect(cell.recordedToken).toBeNull();
  });

  it("a NON-PASSING verdict keeps its verbatim token; approval stamps never recolor it", () => {
    const arts = fullGate({ "rev1-r2": "CONCERNING" });
    const r = composeSliceReview(baseInputs({ artifacts: arts, approval: { spec: null, delivery: DELIVERY_STAMP } }));
    const cell = r.lineage.gateCells.find((c) => c.role === "rev1-r2")!;
    expect(cell.recordedToken).toBe("CONCERNING"); // verbatim — never collapsed to FAIL
    expect(cell.tone).toBe("fail"); // tone derived SEPARATELY
    expect(r.delivered.lock).not.toBeNull(); // the stamp renders...
    expect(cell.state).toBe("non-passing"); // ...but the gate cell keeps its real state
    expect(computeRecordedGreen(r.lineage.gateCells, arts, "cand1234").green).toBe(false); // BR-6
  });

  it("latest-wins supersession within the same (candidate, artifact_type) tuple only", () => {
    const early = artifact({ artifactType: "qa", verdict: "NOT-CLEAR", droppedAt: "2026-07-04T08:00:00.000Z", relPath: "proof/qa-1.md" });
    const later = artifact({ artifactType: "qa", verdict: "PASS", droppedAt: "2026-07-04T09:30:00.000Z", relPath: "proof/qa-2.md" });
    const cells = deriveGateCells([early, later, ...fullGate({ qa: undefined as never }).filter((a) => a.artifactType !== "qa")], "cand1234");
    expect(cells.find((c) => c.role === "qa")!.recordedToken).toBe("PASS");
    // A later artifact for a DIFFERENT candidate does not supersede.
    const otherSha = artifact({ artifactType: "qa", verdict: "NOT-CLEAR", candidateSha: "other999", droppedAt: "2026-07-04T09:45:00.000Z", relPath: "proof/qa-3.md" });
    const cells2 = deriveGateCells([later, otherSha], "cand1234");
    expect(cells2.find((c) => c.role === "qa")!.recordedToken).toBe("PASS");
  });

  it("a PROOF.md self-claimed PASS with zero gate artifacts raises confirm-faithful, never verified anything", () => {
    const r = composeSliceReview(baseInputs({ proofMd: "# Proof\n\nResult: PASS\n" }));
    const cf = r.needsYou.items.find((i) => i.leg === "confirm-faithful");
    expect(cf).toBeDefined();
    expect(cf!.summary).toBe("confirm this proof is faithful");
    expect(r.delivered.items.every((it) => it.verified === "missing")).toBe(true);
    // slice-04 REV6 (qitem-20260722114922): the confirm-faithful evidenceRef is a
    // SLICE-RELATIVE ref (EvidenceOpener joins the current slice-dir relPath, like
    // every other proof ref). It must be exactly "PROOF.md" — emitting the full
    // mission-relative "<mission>/slices/<slice>/PROOF.md" duplicates the slice path
    // in the opener and 404s. GENUINE RED until compose.ts emits slice-relative.
    expect(cf!.evidenceRef).toBe("PROOF.md");
  });

  it("incidental PASS words in a pending PROOF.md do not count as a self-claim", () => {
    const pending = [
      "# Proof",
      "",
      "Closed by: OPEN — build handed to QA   Date: 2026-07-04   Verdict: PENDING",
      "",
      "- walk the claimed-PASS fixture",
      "- rig scope audit PASS",
    ].join("\n");
    expect(proofClaimsPass(pending)).toBe(false);
    const r = composeSliceReview(baseInputs({ proofMd: pending }));
    expect(r.needsYou.items.find((i) => i.leg === "confirm-faithful")).toBeUndefined();
  });

  it("explicit Closed by Verdict: PASS counts as a PROOF.md self-claim", () => {
    expect(proofClaimsPass("Closed by: qa@rig   Date: 2026-07-04   Verdict: PASS")).toBe(true);
  });

  it("an adjudication CLEAR clears confirm-faithful on recompose (regime 2)", () => {
    const adj = artifact({ artifactType: "adjudication", verdict: "CLEAR", relPath: "proof/adjudication.md" });
    const r = composeSliceReview(baseInputs({ proofMd: "Result: PASS\n", artifacts: [adj] }));
    expect(r.needsYou.items.find((i) => i.leg === "confirm-faithful")).toBeUndefined();
  });

  it("N1 lineage: three facts always present; label derives from merge state", () => {
    const cells = deriveGateCells(fullGate(), "cand1234");
    const unmergedFresh = composeLineage("cand1234", { mainTip: "tip", mergeSha: null, mergeIsAncestorOfTip: null, candidateBehindTip: 1 }, cells);
    expect(unmergedFresh).toMatchObject({ candidateSha: "cand1234", mergeSha: null, mainTip: "tip", freshness: "fresh" });
    const unmergedStale = composeLineage("cand1234", { mainTip: "tip", mergeSha: null, mergeIsAncestorOfTip: null, candidateBehindTip: 12 }, cells);
    expect(unmergedStale.freshness).toBe("stale");
    expect(unmergedStale.staleBehind).toBe(12);
    const mergedFresh = composeLineage("cand1234", { mainTip: "tip", mergeSha: "merge55", mergeIsAncestorOfTip: true, candidateBehindTip: null }, cells);
    expect(mergedFresh.freshness).toBe("fresh");
    expect(mergedFresh.mergeSha).toBe("merge55");
  });
});

describe("§4 — the two locks (the SHIPPED staged-approval stamps)", () => {
  it("plan.lock = the spec-scope stamp; delivered.lock = the delivery-scope stamp; independent", () => {
    const specOnly = composeSliceReview(
      baseInputs({ approval: { spec: { by: "planner@rig", at: "2026-07-03T00:00:00.000Z", auditRowPresent: true }, delivery: null } }),
    );
    expect(specOnly.plan.lock).toEqual({ by: "planner@rig", at: "2026-07-03T00:00:00.000Z", auditVerified: true });
    expect(specOnly.delivered.lock).toBeNull();
    expect(specOnly.phase).not.toBe("locked"); // only the delivery stamp locks

    const both = composeSliceReview(
      baseInputs({ approval: { spec: { by: "planner@rig", at: "2026-07-03T00:00:00.000Z", auditRowPresent: true }, delivery: DELIVERY_STAMP } }),
    );
    expect(both.delivered.lock).toEqual({ by: "human@host", at: NOW, auditVerified: true });
    expect(both.phase).toBe("locked");
  });

  it("UNVERIFIED stamp: a stamp with no matching audit row carries auditVerified false — visible, never a block", () => {
    const r = composeSliceReview(
      baseInputs({ approval: { spec: null, delivery: { by: "s", at: NOW, auditRowPresent: false } } }),
    );
    expect(r.delivered.lock).toEqual({ by: "s", at: NOW, auditVerified: false });
    expect(r.phase).toBe("locked"); // fail-open: the stamp still stands; the render flags it
  });

  it("lockedArtifacts pass through as the pinned plan set; media-kind entries surface in plan media", () => {
    const r = composeSliceReview(
      baseInputs({
        lockedArtifacts: [
          { name: "the PRD", path: "IMPLEMENTATION-PRD.md", kind: "spec" },
          { name: "drawer mockup", path: "mockups/drawer-right.png", kind: "mockup" },
        ],
      }),
    );
    expect(r.plan.lockedArtifacts).toHaveLength(2);
    expect(r.plan.concise.media).toContainEqual({ kind: "image", src: "mockups/drawer-right.png", caption: "mockups/drawer-right.png" });
  });
});

describe("FR-1 — verbatim intent, section media, idempotence", () => {
  it("composes twice byte-identically (pure core, view-time facts are inputs)", () => {
    const inputs = baseInputs({ artifacts: fullGate(), proofMd: "PASS" });
    const a = JSON.stringify(composeSliceReview(inputs));
    const b = JSON.stringify(composeSliceReview(inputs));
    expect(a).toBe(b);
  });

  it("projects INTENT character-identical to the source section, with its media", () => {
    const r = composeSliceReview(
      baseInputs({ readme: "---\nt: x\n---\n\n## Intent\n\nThe founder's exact words.\n\n![sketch](sketch.png)\n" }),
    );
    expect(r.intent.text).toContain("The founder's exact words.");
    expect(r.intent.media).toEqual([{ kind: "image", src: "sketch.png", caption: "sketch.png" }]);
    expect(r.intent.ssotPath).toBe("release-t/slices/20-fixture/README.md");
  });

  it("no PRD at the C7 pinned name -> plan degrades to null text, nothing synthesized", () => {
    const r = composeSliceReview(baseInputs({ prd: null }));
    expect(r.plan.concise.text).toBeNull();
    expect(r.plan.ssotPath).toBeNull();
  });

  it("absolute media paths surface as defect findings", () => {
    const r = composeSliceReview(baseInputs({ mediaRefs: ["/abs/path/shot.png", "proof/ok.png"] }));
    expect(r.defects).toHaveLength(1);
    expect(r.defects[0]).toContain("/abs/path/shot.png");
  });

  it("traversal media refs surface as escape-defect findings (rev1 fixback)", () => {
    const r = composeSliceReview(
      baseInputs({ mediaRefs: ["../sibling/shot.png", "proof/sub/../../../x.png", "proof/ok..png", "proof/fine.png"] }),
    );
    expect(r.defects).toHaveLength(2); // ".." as a PATH SEGMENT only — "ok..png" is a filename, not traversal
    expect(r.defects[0]).toContain("../sibling/shot.png");
    expect(r.defects[1]).toContain("proof/sub/../../../x.png");
  });

  it("artifact media escaping the slice dir is a defect finding, never silently curated", () => {
    const qa = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["1"], selfCheck: "looked", mediaRefs: ["../../outside.png", "in-proof.png"] });
    const r = composeSliceReview(baseInputs({ artifacts: [qa] }));
    expect(r.defects.some((d) => d.includes("../../outside.png"))).toBe(true);
    const item = r.delivered.items[0]!;
    expect(item.proof).toEqual([{ kind: "image", src: "proof/in-proof.png", caption: "in-proof.png" }]);
  });
});

describe("FR-3 — five-way derived phase, top-down precedence", () => {
  // release-0.4.7 intent-stage: signal shape reshaped (prdPresent →
  // prdAuthored; proofArtifactPresent → realProofArtifactsPresent; NEW
  // specLocked). Same five-way precedence; the building lane now needs real
  // artifacts OR (qitem AND authored/locked spec).
  const NONE = { prdAuthored: false, realProofArtifactsPresent: false, activeQitemPresent: false, verdictOrEvidenceSetPresent: false, specLocked: false, approved: false };

  it("derives each phase from layer completeness alone", () => {
    expect(derivePhase({ ...NONE })).toBe("intent");
    expect(derivePhase({ ...NONE, prdAuthored: true })).toBe("spec");
    expect(derivePhase({ ...NONE, prdAuthored: true, activeQitemPresent: true })).toBe("building");
    expect(derivePhase({ ...NONE, prdAuthored: true, realProofArtifactsPresent: true, verdictOrEvidenceSetPresent: true })).toBe("review");
    expect(derivePhase({ ...NONE, prdAuthored: true, realProofArtifactsPresent: true, verdictOrEvidenceSetPresent: true, approved: true })).toBe("locked");
  });

  it("a bare tracking qitem is coordination, not construction (AR-3)", () => {
    expect(derivePhase({ ...NONE, activeQitemPresent: true })).toBe("intent");
    expect(derivePhase({ ...NONE, activeQitemPresent: true, specLocked: true })).toBe("building");
    expect(derivePhase({ ...NONE, activeQitemPresent: true, prdAuthored: true })).toBe("building");
  });

  it("specLocked alone promotes to spec (authored by fiat); real artifacts alone build", () => {
    expect(derivePhase({ ...NONE, specLocked: true })).toBe("spec");
    expect(derivePhase({ ...NONE, realProofArtifactsPresent: true })).toBe("building");
  });

  it("one signal satisfying two lanes resolves by precedence, deterministically", () => {
    const s = { ...NONE, prdAuthored: true, realProofArtifactsPresent: true, verdictOrEvidenceSetPresent: true };
    expect(derivePhase(s)).toBe("review");
    expect(derivePhase(s)).toBe(derivePhase({ ...s }));
  });

  it("maps phases to the SS14 lane vocabulary", () => {
    const r = composeSliceReview(baseInputs({ prd: null, readme: null }));
    expect(r.phase).toBe("intent");
    expect(r.laneLabel).toBe("INTENT");
    const spec = composeSliceReview(baseInputs());
    expect(spec.laneLabel).toBe("PLAN");
  });
});

describe("§3.1 DELIVERED — the redesigned join (planned ↔ curated proof ↔ verified)", () => {
  const promised = extractProofContract(baseInputs().prd);

  it("verified REQUIRES a passing recorded QA comparison (self_check + passing verdict), never presence", () => {
    const qa = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["1"], selfCheck: "watched it play", mediaRefs: ["playing.webm"] });
    const d = composeDelivered(promised, [qa]);
    expect(d.items[0]).toMatchObject({ verified: "verified", note: "watched it play" });
    expect(d.items[0]!.proof).toEqual([{ kind: "video", src: "proof/playing.webm", caption: "playing.webm" }]);
    expect(d.items[1]).toMatchObject({ verified: "missing" });
    expect(d.missingCount).toBe(1);
  });

  it("a covering artifact WITHOUT a recorded comparison leaves the item unverified — visible, not blocked", () => {
    const guardArt = artifact({ artifactType: "guard", verdict: "CLEAR", evidences: ["range probe 206"] });
    const d = composeDelivered(promised, [guardArt]);
    expect(d.items[1]!.verified).toBe("unverified"); // non-QA artifact type can never verify
    const qaNoSelfCheck = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["1"] });
    expect(composeDelivered(promised, [qaNoSelfCheck]).items[0]!.verified).toBe("unverified");
  });

  it("QA's why-kicked-back note surfaces while a NON-PASSING comparison stays unverified", () => {
    const kicked = artifact({ artifactType: "qa", verdict: "BLOCKING", evidences: ["1"], selfCheck: "mockup shows right drawer; build opens left — kicked back" });
    const d = composeDelivered(promised, [kicked]);
    expect(d.items[0]!.verified).toBe("unverified");
    expect(d.items[0]!.note).toContain("kicked back");
  });

  it("matches evidences refs by exact text as well as 1-based index", () => {
    const byText = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["range probe 206"], selfCheck: "saw the 206" });
    const d = composeDelivered(promised, [byText]);
    expect(d.items[1]!.verified).toBe("verified");
    expect(d.items[0]!.verified).toBe("missing");
  });

  it("no contract declared -> zero items, zero missing (never trivially-sufficient, never an invented row)", () => {
    const d = composeDelivered([], [artifact({ artifactType: "qa", verdict: "PASS", mediaRefs: ["x.png"] })]);
    expect(d.items).toHaveLength(0);
    expect(d.missingCount).toBe(0);
    expect(d.extraProof).toEqual([{ kind: "image", src: "proof/x.png", caption: "x.png" }]); // §6: visible under its own label
  });

  it("unmapped-artifact media renders bounded as extraProof — shown, never a primary-view pile", () => {
    const stray = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["something else entirely"], mediaRefs: ["stray.png"] });
    const d = composeDelivered(promised, [stray]);
    expect(d.extraProof).toEqual([{ kind: "image", src: "proof/stray.png", caption: "stray.png" }]);
    expect(d.items.every((it) => it.proof.length === 0)).toBe(true);
  });

  it("plannedRef: a markdown image on the contract line pairs the mockup with the deliverable", () => {
    const prd = "## Proof contract\n\n- [ ] drawer opens right ![mockup](mockups/drawer.png)\n- [ ] range probe 206\n";
    const items = extractProofContract(prd);
    // VM-006: `rawText` carries the authored bytes (image markup intact) while
    // `text` stays stripped — the two carriers the Progress↔Review join and the
    // DELIVERED render read respectively.
    expect(items[0]).toEqual({
      text: "drawer opens right",
      rawText: "drawer opens right ![mockup](mockups/drawer.png)",
      plannedRef: "mockups/drawer.png",
    });
    const d = composeDelivered(items, []);
    expect(d.items[0]!.promised.plannedRef).toEqual({ kind: "image", src: "mockups/drawer.png", caption: "mockups/drawer.png" });
    expect(d.items[1]!.promised.plannedRef).toBeUndefined();
  });

  it("curated proof set is deduped and ordered latest-artifact-first", () => {
    const older = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["1"], selfCheck: "v1", mediaRefs: ["a.png", "b.png"], droppedAt: "2026-07-04T08:00:00.000Z", relPath: "proof/qa-1.md" });
    const newer = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["1"], selfCheck: "v2 — the canonical set", mediaRefs: ["b.png", "c.png"], droppedAt: "2026-07-04T09:30:00.000Z", relPath: "proof/qa-2.md" });
    const d = composeDelivered(promised, [older, newer]);
    expect(d.items[0]!.proof.map((p) => p.src)).toEqual(["proof/b.png", "proof/c.png", "proof/a.png"]);
    expect(d.items[0]!.note).toBe("v2 — the canonical set"); // latest recorded comparison wins the note
  });

  it("feeds the ▲ insufficient-proof signal from the delivered.items MISSING count (§11 re-bind)", () => {
    const r = composeSliceReview(baseInputs()); // contract declared, nothing delivered
    const insufficient = r.needsYou.items.find((i) => i.derived?.kind === "insufficient-proof");
    expect(insufficient).toBeDefined();
    expect(insufficient!.derived!.evidence).toContain("2 of 2");
    expect(insufficient!.derived!.threshold).toBe("delivered.items MISSING count > 0");
  });

  it("proofDirPath is the drill-in door when proof/ exists, null when it does not", () => {
    expect(composeSliceReview(baseInputs()).delivered.proofDirPath).toBe("release-t/slices/20-fixture/proof");
    expect(composeSliceReview(baseInputs({ proofDirExists: false })).delivered.proofDirPath).toBeNull();
  });
});

describe("markdown structure + media extraction", () => {
  it("extracts sections, mini-reqs, proof contracts, and media refs", () => {
    const prd = baseInputs().prd!;
    expect(extractMiniReqs(prd)).toContain("1. One surface.");
    expect(extractProofContract(prd).map((p) => p.text)).toEqual(["phone journey video", "range probe 206"]);
    expect(extractSection("## A\n\nbody a\n\n## B\n\nbody b", "B")).toBe("body b");
    expect(extractSection(null, "A")).toBeNull();
    expect(extractMediaRefs('x ![a](a.png) y <video src="v.mp4"> z ![h](http://x/h.png)')).toEqual(["a.png", "v.mp4"]);
  });

  it("slice-relative normalization: proof-relative refs join; escapes return null", () => {
    expect(sliceRelativeMediaPath("shot.png", "proof")).toBe("proof/shot.png");
    expect(sliceRelativeMediaPath("../mockups/m.png", "proof")).toBe("mockups/m.png");
    expect(sliceRelativeMediaPath("../../out.png", "proof")).toBeNull();
    expect(sliceRelativeMediaPath("/abs.png", "proof")).toBeNull();
    expect(sliceRelativeMediaPath("sketch.png", "")).toBe("sketch.png");
  });
});

describe("FR-7 — mission composition (the ledger keeps recorded-verdict green)", () => {
  function entry(name: string, over: Partial<SliceComposeInputs> = {}): MissionSliceEntry {
    const inputs = baseInputs({ slice: { name, id: null, title: name, missionId: "m" }, ...over });
    return { review: composeSliceReview(inputs), green: composeRecordedGreenForSlice(inputs.artifacts).green };
  }

  it("the ledger is a query over the slice set — the tracking-gap replay renders all slices", () => {
    const slices = [
      entry("s1", { artifacts: fullGate(), git: { mainTip: "tip", mergeSha: "m1", mergeIsAncestorOfTip: true, candidateBehindTip: null } }),
      entry("s2", { artifacts: fullGate(), git: { mainTip: "tip", mergeSha: "m2", mergeIsAncestorOfTip: true, candidateBehindTip: null } }),
      entry("s3", { artifacts: fullGate(), git: { mainTip: "tip", mergeSha: "m3", mergeIsAncestorOfTip: true, candidateBehindTip: null } }),
      entry("s4"),
    ];
    const m = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices, missionAttention: [], agents: [], nowIso: NOW });
    expect(m.ledger).toHaveLength(4); // omission-proof by construction
    expect(m.ledger.filter((r) => r.green)).toHaveLength(3);
  });

  it("cut-complete requires green AND merged AND zero needs-human for EVERY slice", () => {
    const greenUnmerged = entry("s1", { artifacts: fullGate() }); // green but UNMERGED
    const m1 = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices: [greenUnmerged], missionAttention: [], agents: [], nowIso: NOW });
    expect(m1.cutComplete).toBe(false); // proven-but-unmerged is NOT cut-complete
    const greenMerged = entry("s1", {
      artifacts: fullGate(),
      git: { mainTip: "tip", mergeSha: "m1", mergeIsAncestorOfTip: true, candidateBehindTip: null },
      prd: baseInputs().prd!.replace("## Proof contract\n\n- [ ] phone journey video\n- [ ] range probe 206\n", ""),
    });
    const m2 = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices: [greenMerged], missionAttention: [], agents: [], nowIso: NOW });
    expect(greenMerged.review.needsYou.items).toHaveLength(0);
    expect(m2.cutComplete).toBe(true);
  });

  it("board cells re-bind to the collapsed contract: n/m from delivered items, stamps from the locks", () => {
    const building = entry("s1", { activeQitemPresent: true, artifacts: [artifact({ artifactType: "qa", verdict: null, evidences: ["1"], relPath: "proof/wip.md" })] });
    const m = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices: [building], missionAttention: [], agents: [], nowIso: NOW });
    expect(m.board[0]!.stageCell).toBe("1/2 proofs");
    const specStamped = entry("s2", { artifacts: [], approval: { spec: { by: "p", at: "2026-07-03T00:00:00.000Z", auditRowPresent: true }, delivery: null }, proofMd: null });
    const m2 = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices: [specStamped], missionAttention: [], agents: [], nowIso: NOW });
    expect(m2.board[0]!.stageCell).toBe("spec-approved 2026-07-03T00:00:00.000Z");
  });

  it("mission NEEDS YOU is a union of distinct identities — one item seen from N heights, never N items", () => {
    const s1 = entry("s1"); // carries the insufficient-proof ▲
    const m = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices: [s1, s1], missionAttention: [], agents: [], nowIso: NOW });
    const ids = m.needsYou.items.map((i) => i.identity);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("empty mission renders honest zero-state provenance", () => {
    const m = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices: [], missionAttention: [], agents: [], nowIso: NOW });
    expect(m.board).toHaveLength(0);
    expect(m.cutComplete).toBe(false);
    expect(m.needsYou.provenance).toContain("0 attention items");
  });
});

describe("candidate derivation", () => {
  it("takes the candidate_sha of the latest-dropped gate artifact, ignoring adjudications", () => {
    const arts = [
      artifact({ artifactType: "guard", verdict: "CLEAR", candidateSha: "old1", droppedAt: "2026-07-04T07:00:00.000Z", relPath: "proof/g1.md" }),
      artifact({ artifactType: "qa", verdict: "PASS", candidateSha: "new2", droppedAt: "2026-07-04T09:00:00.000Z", relPath: "proof/q2.md" }),
      artifact({ artifactType: "adjudication", verdict: "CLEAR", candidateSha: "adj3", droppedAt: "2026-07-04T09:30:00.000Z", relPath: "proof/a3.md" }),
    ];
    expect(deriveCandidateSha(arts)).toBe("new2");
  });
});

// ---------------------------------------------------------------------------
// release-0.4.7 intent-stage/scaffold-projection — T2 (placeholder-only
// contract → []), T3 (regime matrix, composer-level), T7 (byte-identity
// carve, compose half).
//
// Fixtures are TEMPLATE-DERIVED: rendered with the REAL CLI renderers
// (dynamic-imported exactly like scope-audit-parity.test.ts does) so a
// template drift breaks these tests honestly. A pristine `rig scope slice
// create` output is the canonical intent-stage fixture.
// ---------------------------------------------------------------------------

import * as nodePath from "node:path";
import { beforeAll as beforeAllIntent } from "vitest";

const INTENT_REPO_ROOT = nodePath.resolve(import.meta.dirname, "..", "..", "..");

interface PristineFixture {
  readme: string;
  prd: string;
  proof: string;
}

let pristine: PristineFixture;

beforeAllIntent(async () => {
  const mod = await import(
    nodePath.join(INTENT_REPO_ROOT, "packages/cli/src/lib/scope/templates.ts")
  );
  const opts = {
    id: "OPR.T.99",
    slice_number: "99",
    slug: "pristine",
    mission: "release-t",
    title: "Pristine",
    created_date: "2026-07-11",
  };
  pristine = {
    readme: mod.renderSliceTemplate("placeholder", opts),
    prd: mod.renderImplementationPrdTemplate(opts),
    proof: mod.renderSliceProofTemplate({ id: "OPR.T.99", title: "Pristine" }),
  };
});

describe("T2 — extractProofContract filters scaffold placeholders", () => {
  it("a pristine template PRD's contract extracts to [] (placeholder-only)", () => {
    expect(extractProofContract(pristine.prd)).toEqual([]);
  });

  it("an authored line survives byte-exact next to the placeholder; bracket-edge text survives", () => {
    const prd = pristine.prd.replace(
      /^## Proof contract\s*$/m,
      "## Proof contract\n\n- [ ] phone journey video\n- [ ] [P0] ship the drawer",
    );
    const items = extractProofContract(prd);
    expect(items.map((i) => i.text)).toEqual(["phone journey video", "[P0] ship the drawer"]);
  });

  it("the pristine template PROOF.md does NOT claim a pass (verdict is a placeholder)", () => {
    expect(proofClaimsPass(pristine.proof)).toBe(false);
  });
});

describe("T3 — regime matrix (multi-regime preserved, don't-collapse)", () => {
  function pristineInputs(over: Partial<SliceComposeInputs> = {}): SliceComposeInputs {
    return baseInputs({
      readme: pristine.readme,
      prd: pristine.prd,
      proofMd: pristine.proof,
      proofDirExists: true,
      ...over,
    });
  }

  it("row 1: pristine scaffold + tracking qitem → INTENT, with all three honest empties", () => {
    const r = composeSliceReview(pristineInputs({ activeQitemPresent: true }));
    expect(r.phase).toBe("intent");
    // DELIVERED honest empty (VM-002): no placeholder promises survive.
    expect(r.delivered.items).toHaveLength(0);
    // PLAN honest empty (S5 fold-in): placeholder-only mini-reqs renders as not planned.
    expect(r.plan.concise.text).toBeNull();
  });

  it("row 2: pristine scaffold + zero qitems → INTENT", () => {
    expect(composeSliceReview(pristineInputs()).phase).toBe("intent");
  });

  it("row 3: authored PRD + qitem + no plan-lock → BUILDING (prdAuthored leg)", () => {
    const r = composeSliceReview(baseInputs({ activeQitemPresent: true }));
    expect(r.phase).toBe("building");
  });

  it("row 4: plan-locked pristine + qitem → BUILDING (specLocked leg — authored by fiat)", () => {
    const r = composeSliceReview(
      pristineInputs({ activeQitemPresent: true, approval: { spec: DELIVERY_STAMP, delivery: null } }),
    );
    expect(r.phase).toBe("building");
  });

  it("row 5: verdict-bearing PROOF.md → REVIEW (tier logic untouched — the non-goal held)", () => {
    const r = composeSliceReview(
      pristineInputs({ proofMd: "Closed by: qa@rig   Date: 2026-07-11   Verdict: PASS\n\nProven.\n" }),
    );
    expect(r.phase).toBe("review");
  });

  it("row 6: a real C1 drop moves the pristine scaffold out of INTENT (BUILDING/REVIEW)", () => {
    const r = composeSliceReview(pristineInputs({ artifacts: [artifact({ artifactType: "qa" })] }));
    expect(["building", "review"]).toContain(r.phase);
  });

  it("row 7: authored mini-reqs + placeholder-only contract → SPEC and PLAN text renders (independent sections)", () => {
    const prd = pristine.prd.replace(
      /^1\. \[.*\]$/m,
      "1. One real observable outcome.",
    );
    const r = composeSliceReview(pristineInputs({ prd }));
    expect(r.phase).toBe("spec");
    expect(r.plan.concise.text).toContain("1. One real observable outcome.");
    expect(r.delivered.items).toHaveLength(0);
  });

  it("row 3b: a bare tracking qitem with NO authored/locked spec is coordination, not construction → INTENT", () => {
    const r = composeSliceReview(pristineInputs({ activeQitemPresent: true, proofMd: null }));
    expect(r.phase).toBe("intent");
  });
});

describe("T7 — byte-identity carve (compose half): authored slices project identically", () => {
  it("the fully-authored fixture keeps its exact pre-change projection", () => {
    const r = composeSliceReview(baseInputs());
    expect(r.phase).toBe("spec");
    expect(r.delivered.items.map((i) => i.promised.text)).toEqual(["phone journey video", "range probe 206"]);
    expect(r.plan.concise.text).toContain("1. One surface.");
    expect(r.plan.concise.text).toContain("2. Verified from recorded QA comparisons only.");
    expect(r.intent.text).toContain("The founder's exact words.");
  });

  it("an authored slice with artifacts + qitem keeps its phase behavior", () => {
    expect(composeSliceReview(baseInputs({ activeQitemPresent: true })).phase).toBe("building");
    expect(composeSliceReview(baseInputs({ artifacts: fullGate() })).phase).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// release-0.4.7 placeholder-suppression completeness — T-B1 (INTENT section:
// placeholder-only projects the existing honest degrade; authored intent
// byte-identical) + T-C compose leg (prose/bullet-only mini-reqs suppression
// pin — asserts shipped b8c11535 behavior, zero behavior change intended).
// ---------------------------------------------------------------------------

describe("T-B1 — INTENT placeholder-only projects the honest degrade (micro-bundle B)", () => {
  it("pristine template README (bracket-wrapped Intent) → intent.text null + 'no intent recorded'", () => {
    const r = composeSliceReview(baseInputs({ readme: pristine.readme, prd: pristine.prd, proofMd: pristine.proof }));
    expect(r.intent.text).toBeNull();
    expect(r.intent.degrade).toBe("no intent recorded");
  });

  it("two-line `[a]\\n[b]` placeholder Intent → degrade (per-line block grammar)", () => {
    const readme = "---\ntitle: t\n---\n\n# F\n\n## Intent\n\n[a]\n[b]\n";
    const r = composeSliceReview(baseInputs({ readme }));
    expect(r.intent.text).toBeNull();
    expect(r.intent.degrade).toBe("no intent recorded");
  });

  it("AUTHORED intent projects byte-identically (the carve — filter never eats a real intent)", () => {
    const r = composeSliceReview(baseInputs());
    expect(r.intent.text).toContain("The founder's exact words.");
    expect(r.intent.degrade).toBeNull();
    const mixed = composeSliceReview(baseInputs({ readme: baseInputs().readme!.replace("The founder's exact words.", "[looks-bracketed] but authored words follow") }));
    expect(mixed.intent.text).toContain("[looks-bracketed] but authored words follow");
  });

  it("ABSENT Intent section keeps its own state (null → same degrade, unchanged contract)", () => {
    const r = composeSliceReview(baseInputs({ readme: "---\nt: 1\n---\n\n# F\n\nno intent heading here\n" }));
    expect(r.intent.text).toBeNull();
    expect(r.intent.degrade).toBe("no intent recorded");
  });
});

describe("T-C — prose/bullet-only mini-reqs suppression pin (reviewer-L1 ruling; shipped behavior)", () => {
  it("prose-only mini-reqs → PLAN '— not planned yet' (concise text null)", () => {
    const prd = "## Mini-requirements\n\nJust prose, no numbered tier.\n\n## Proof contract\n\n- [ ] real item\n";
    const r = composeSliceReview(baseInputs({ prd }));
    expect(r.plan.concise.text).toBeNull();
  });

  it("bullet-only mini-reqs → concise text null", () => {
    const prd = "## Mini-requirements\n\n- bullet one\n- bullet two\n\n## Proof contract\n\n- [ ] real item\n";
    const r = composeSliceReview(baseInputs({ prd }));
    expect(r.plan.concise.text).toBeNull();
  });

  it("mixed prose + ONE authored numbered item → renders", () => {
    const prd = "## Mini-requirements\n\nContext prose.\n\n1. One real outcome.\n\n## Proof contract\n\n- [ ] real item\n";
    const r = composeSliceReview(baseInputs({ prd }));
    expect(r.plan.concise.text).toContain("1. One real outcome.");
  });
});

// ---------------------------------------------------------------------------
// PM dogfood #1 (qitem-20260720015700-630eef64) — Review projection: authored
// README convention sections must project on PLAN/DELIVERED when the
// corresponding PRD section is PRISTINE scaffold-only. Authored PRD stays
// canonical. Selection is per-section and never reads lifecycle status.
// ---------------------------------------------------------------------------

describe("PM dogfood #1 — compose projects authored README sections over pristine PRD sections", () => {
  const AUTHORED_README = [
    "---",
    "id: OPR.99.0.2.1",
    "status: placeholder",
    "---",
    "",
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

  it("pristine PRD + authored README: PLAN renders the authored mini-reqs; DELIVERED joins the authored contract; ssotPath names the README; phase derives spec", () => {
    // pristine.prd = the real renderer output (file-scoped intent-stage fixture).
    const r = composeSliceReview(baseInputs({ readme: AUTHORED_README, prd: pristine.prd }));
    expect(r.plan.concise.text).not.toBeNull(); // RED pre-fix: no projection
    expect(r.plan.concise.text!).toContain("first authored requirement");
    expect(r.delivered.items.map((i) => i.promised.text)).toEqual([
      "authored deliverable one — captured",
      "authored deliverable two — captured",
    ]);
    expect(r.plan.ssotPath?.endsWith("README.md")).toBe(true);
    // The single-parse pin: the same selected parse drives render AND signal —
    // authored structured requirements project, so the derived phase is spec
    // (a projection; no stored status is read or written by the selection).
    expect(r.phase).toBe("spec");
  });

  it("PIN: authored PRD stays canonical even when the README sections are ALSO authored (differently)", () => {
    const r = composeSliceReview(baseInputs({ readme: AUTHORED_README })); // baseInputs' default prd is authored
    expect(r.plan.concise.text).not.toBeNull();
    expect(r.plan.concise.text!).toContain("One surface.");
    expect(r.plan.concise.text!).not.toContain("first authored requirement");
    expect(r.delivered.items.map((i) => i.promised.text)).toEqual([
      "phone journey video",
      "range probe 206",
    ]);
    expect(r.plan.ssotPath?.endsWith("IMPLEMENTATION-PRD.md")).toBe(true);
  });

  it("STATUS-INVARIANCE: README frontmatter status placeholder vs planned projects identically", () => {
    const asPlanned = AUTHORED_README.replace("status: placeholder", "status: planned");
    const a = composeSliceReview(baseInputs({ readme: AUTHORED_README, prd: pristine.prd }));
    const b = composeSliceReview(baseInputs({ readme: asPlanned, prd: pristine.prd }));
    expect(b.plan).toEqual(a.plan);
    expect(b.delivered).toEqual(a.delivered);
    expect(b.phase).toEqual(a.phase);
  });
});

// ---------------------------------------------------------------------------
// qitem-render-driver B — checkbox CONTINUATION lines are dropped from the
// payload before the UI ever sees them (QA: DELIVERED strings are truncated at
// continuation boundaries, with no CSS overflow involved).
//
// Root: extractProofContract iterates body.split("\n") and matches a SINGLE
// line (/^\s*-?\s*\[( |x|X)\]\s+(.+)$/), so an indented continuation of a
// checkbox is discarded.
//
// Contract pinned here (guard-corrected): the shared logical-checkbox record
// carries {checked, rawText, sourceLine}; rawText joins an ELIGIBLE indented
// continuation with exactly ONE U+0020 and IS the VM-006 join key; compose
// derives display text/plannedRef FROM rawText. Eligible continuation =
// nonblank, non-checkbox, indentation strictly deeper than the checkbox line.
// A next checkbox, a blank line, or same/shallower prose terminates the item.
// sourceLine stays the CHECKBOX line.
// ---------------------------------------------------------------------------

describe("qitem-render-driver B — proof-contract continuation joins into one logical item", () => {
  const contract = (body: string) => `# PRD\n\n## Proof contract\n\n${body}\n`;

  it("RED: an indented continuation joins its checkbox into ONE item with a single-space join", () => {
    const items = extractProofContract(contract("- [ ] the drawer opens on the right\n      and stays open across a reload"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("the drawer opens on the right and stays open across a reload");
    expect(items[0]!.text).toBe("the drawer opens on the right and stays open across a reload");
  });

  it("RED: multiple continuation lines all join, each with exactly one space", () => {
    const items = extractProofContract(contract("- [ ] first fragment\n    second fragment\n      third fragment"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("first fragment second fragment third fragment");
  });

  it("GREEN boundary: the NEXT checkbox terminates the previous item (no cross-item absorption)", () => {
    const items = extractProofContract(contract("- [ ] alpha promise\n- [x] beta promise"));
    expect(items.map((i) => i.rawText)).toEqual(["alpha promise", "beta promise"]);
  });

  it("GREEN boundary: a BLANK line terminates the item", () => {
    const items = extractProofContract(contract("- [ ] alpha promise\n\n      orphaned prose"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("alpha promise");
  });

  it("RED: eligibility is RELATIVE depth — with an INDENTED checkbox, a DEEPER-indented line joins", () => {
    // The checkbox itself sits at 2 spaces; the continuation at 6 (strictly
    // deeper) must join. A column-zero-only fixture cannot tell "any leading
    // whitespace" from true relative-depth semantics.
    const items = extractProofContract(contract("  - [ ] indented promise\n      deeper continuation"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("indented promise deeper continuation");
  });

  it("GREEN boundary: with an INDENTED checkbox, SAME-indent prose does NOT join", () => {
    // Same 2-space indent as the checkbox => not strictly deeper => terminates.
    const items = extractProofContract(contract("  - [ ] indented promise\n  same-depth prose"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("indented promise");
  });

  it("GREEN boundary: with an INDENTED checkbox, SHALLOWER prose does NOT join", () => {
    const items = extractProofContract(contract("    - [ ] deeply indented promise\n  shallower prose"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("deeply indented promise");
  });

  it("GREEN boundary: NON-indented (same/shallower) prose does NOT join", () => {
    const items = extractProofContract(contract("- [ ] alpha promise\nplain prose at column zero"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("alpha promise");
  });

  it("RED: checked state is carried per item AND its continuation joins", () => {
    const items = extractProofContract(contract("- [x] done promise\n      with a continuation\n- [ ] open promise"));
    expect(items).toHaveLength(2);
    expect(items[0]!.rawText).toBe("done promise with a continuation");
    expect(items[1]!.rawText).toBe("open promise");
  });

  it("RED: plannedRef/text derive from rawText (image kept in rawText, stripped from text) WITH the continuation joined", () => {
    const items = extractProofContract(contract("- [ ] the panel renders ![planned](mockups/panel.png)\n      after a reload"));
    expect(items).toHaveLength(1);
    expect(items[0]!.plannedRef).toBe("mockups/panel.png");
    expect(items[0]!.rawText).toContain("![planned](mockups/panel.png)");
    expect(items[0]!.rawText).toContain("after a reload");
    expect(items[0]!.text).not.toContain("![planned]");
    expect(items[0]!.text).toContain("after a reload");
  });

  it("GREEN: malformed / missing / placeholder contracts stay honest", () => {
    expect(extractProofContract(null)).toEqual([]);
    expect(extractProofContract("# PRD\n\n## Notes\n\nno contract here\n")).toEqual([]);
    expect(extractProofContract(contract("prose only, no checkboxes"))).toEqual([]);
    // Scaffold placeholder row (bracket-wrapped) still filtered, continuation or not.
    expect(extractProofContract(contract("- [ ] [One promised deliverable]\n      [with a placeholder continuation]"))).toEqual([]);
  });
});
