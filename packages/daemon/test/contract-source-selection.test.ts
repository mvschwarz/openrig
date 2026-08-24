// KI-5.3-2 follow-up (row e69daaef; r1 A3 CONFIRMED in verdict 17dbf8ba) — the
// proof-contract SOURCE-SELECTION split-brain, pinned as the exact observed
// shape: pristine PRD + authored SPEC + no authored README. proof-add derives
// from SPEC (folded at 42f355a03) while compose's DELIVERED pairing and the
// scope audit fall back to README with NO SPEC path — evidence records against
// one contract and displays against another. The fix one-homes the SELECTION
// beside the shared pristine predicate; all readers consume it. These are the
// RED discriminators committed ahead of the production fix per the row's
// sequencing (the fix re-grounds on post-Slice-07 main).

import { describe, it, expect } from "vitest";
import { selectProofContractSource } from "../src/domain/scope/scaffold-placeholder.js";
import { extractProofContractSelected } from "../src/domain/review/compose.js";

const PRISTINE_PRD = "---\nid: x\n---\n# s\n\n## Proof contract\n\n- [ ] [One promised deliverable, written as an observable outcome — captured.]\n";
const AUTHORED_SPEC = "---\nid: x\n---\n# s\n\n## Proof contract\n\n- [ ] ALPHA DOOR: alpha proves itself\n- [ ] BETA DOOR: beta proves itself\n- [ ] GAMMA DOOR: gamma proves itself\n";
const AUTHORED_PRD = "---\nid: x\n---\n# s\n\n## Proof contract\n\n- [ ] REAL ITEM ONE\n- [ ] REAL ITEM TWO\n";

describe("selectProofContractSource — the ONE selection home (scaffold-placeholder territory)", () => {
  it("the observed split-brain shape: pristine PRD + authored SPEC + no README selects the SPEC", () => {
    const sel = selectProofContractSource({ prd: PRISTINE_PRD, spec: AUTHORED_SPEC, readme: null });
    expect(sel.source).toBe("spec");
    expect(sel.items).toHaveLength(3);
    expect(sel.items[1]).toContain("BETA DOOR");
  });

  it("an authored PRD stays canonical over everything (the first-face ruling)", () => {
    const sel = selectProofContractSource({ prd: AUTHORED_PRD, spec: AUTHORED_SPEC, readme: "## Proof contract\n- [ ] readme item\n" });
    expect(sel.source).toBe("prd");
    expect(sel.items).toEqual(["REAL ITEM ONE", "REAL ITEM TWO"]);
  });

  it("pristine PRD + no SPEC contract + authored README keeps the shipped README fallback", () => {
    const sel = selectProofContractSource({ prd: PRISTINE_PRD, spec: null, readme: "---\nid: x\n---\n# s\n\n## Proof contract\n\n- [ ] readme item\n" });
    expect(sel.source).toBe("readme");
    expect(sel.items).toEqual(["readme item"]);
  });

  it("everything pristine or absent: no contract, named as such — never the placeholder index", () => {
    const sel = selectProofContractSource({ prd: PRISTINE_PRD, spec: null, readme: null });
    expect(sel.source).toBeNull();
    expect(sel.items).toEqual([]);
  });
});

describe("the readers AGREE — the split-brain discriminator", () => {
  it("compose's DELIVERED pairing selects the same source as the one home on the observed shape", () => {
    // Currently RED: extractProofContractSelected has no SPEC path and returns
    // the PRD placeholder on this exact shape.
    const composed = extractProofContractSelected(PRISTINE_PRD, null, AUTHORED_SPEC);
    const home = selectProofContractSource({ prd: PRISTINE_PRD, spec: AUTHORED_SPEC, readme: null });
    expect(composed.items.map((i: { text?: string } | string) => (typeof i === "string" ? i : i.text))).toEqual(home.items);
    expect(composed.source).toBe("spec");
  });
});
