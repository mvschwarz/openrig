// KI-5.3-2 follow-up (row e69daaef; r1 A3 CONFIRMED in verdict 17dbf8ba) — the
// proof-contract SOURCE-SELECTION one-home and the readers'-agreement
// discriminators. The confirmed split: proof-add derived from SPEC while
// compose's DELIVERED pairing had no SPEC path at the FUNCTION level. (Wiring
// truth found during the fix, stated for the record: compose/audit callers
// pass the resolved NODE FILE — SPEC-first precedence — so on the observed
// shape their BYTES already agreed; the residual function-level divergence and
// the source-label honesty are what this closes, plus proof-add's missing
// README-node-file corner.)

import { describe, it, expect } from "vitest";
import { selectProofContractBody } from "../src/domain/scope/scaffold-placeholder.js";
import { extractProofContractSelected } from "../src/domain/review/compose.js";

const PRISTINE_BODY = "- [ ] [One promised deliverable, written as an observable outcome — captured.]";
const SPEC_BODY = "- [ ] ALPHA DOOR: alpha proves itself\n- [ ] BETA DOOR: beta proves itself\n- [ ] GAMMA DOOR: gamma proves itself";
const AUTHORED_PRD_BODY = "- [ ] REAL ITEM ONE\n- [ ] REAL ITEM TWO";

const doc = (body: string) => `---\nid: x\n---\n# s\n\n## Proof contract\n\n${body}\n`;

describe("selectProofContractBody — the ONE selection home (scaffold-placeholder twins)", () => {
  it("the observed split-brain shape: pristine PRD + authored SPEC + no README selects the SPEC", () => {
    const sel = selectProofContractBody({ prdBody: PRISTINE_BODY, specBody: SPEC_BODY, readmeBody: null });
    expect(sel.source).toBe("spec");
    expect(sel.body).toBe(SPEC_BODY);
  });

  it("an authored PRD stays canonical over everything (the first-face ruling)", () => {
    const sel = selectProofContractBody({ prdBody: AUTHORED_PRD_BODY, specBody: SPEC_BODY, readmeBody: "- [ ] readme item" });
    expect(sel.source).toBe("prd");
  });

  it("pristine PRD + no SPEC + authored README keeps the shipped node-file fallback (README slot)", () => {
    const sel = selectProofContractBody({ prdBody: PRISTINE_BODY, specBody: null, readmeBody: "- [ ] readme item" });
    expect(sel.source).toBe("readme");
  });

  it("everything pristine or absent: source null — never the placeholder", () => {
    const sel = selectProofContractBody({ prdBody: PRISTINE_BODY, specBody: null, readmeBody: null });
    expect(sel.source).toBeNull();
    expect(sel.body).toBeNull();
  });

  it("SPEC-before-README precedence mirrors NODE_FILE_PRECEDENCE when both are authored", () => {
    const sel = selectProofContractBody({ prdBody: null, specBody: SPEC_BODY, readmeBody: "- [ ] readme item" });
    expect(sel.source).toBe("spec");
  });
});

describe("the readers AGREE — the split-brain discriminator", () => {
  it("compose's DELIVERED pairing selects the same source AND the same indices as the one home on the observed shape", () => {
    const composed = extractProofContractSelected(doc(PRISTINE_BODY), null, doc(SPEC_BODY));
    expect(composed.source).toBe("spec");
    expect(composed.items.map((i) => i.text)).toEqual([
      "ALPHA DOOR: alpha proves itself",
      "BETA DOOR: beta proves itself",
      "GAMMA DOOR: gamma proves itself",
    ]);
  });

  it("compose's legacy 2-arg call (node file in the readme slot) yields the SAME indices — wiring-compatible", () => {
    const composed = extractProofContractSelected(doc(PRISTINE_BODY), doc(SPEC_BODY));
    expect(composed.items.map((i) => i.text)).toEqual([
      "ALPHA DOOR: alpha proves itself",
      "BETA DOOR: beta proves itself",
      "GAMMA DOOR: gamma proves itself",
    ]);
  });
});
