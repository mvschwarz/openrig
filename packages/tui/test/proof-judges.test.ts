// #2765: the proof provenance view lists each policy judge's own latest judgment, and says which ones decide the item.
import { describe, expect, it } from "vitest";
import { proofProvenanceLines, type ReadinessSnap } from "../src/scopes/scopes-model.js";

const judges = [
  { actor: "review-r1@trial", state: "accepted", reason: "r1 accept", sequence: 2, decides: true },
  { actor: "review-r2@trial", state: "rejected", reason: "r2 reject", sequence: 1, decides: false },
];
function readiness(everyJudge: boolean, state: string, reason: string): ReadinessSnap {
  return {
    configured: true, state: "not-ready", revision: "rev", issues: [],
    policy: { judges: ["review-r1@trial", "review-r2@trial"], everyJudge },
    items: [{ id: "a", index: 1, text: "Prove it", state, reason, judgment: { id: "latest", actor: "review-r1@trial", verdict: "accept", evidence: [] },
      judges: everyJudge ? judges.map((j) => ({ ...j, decides: true })) : judges }],
  };
}
const text = (r: ReadinessSnap) => proofProvenanceLines(r, 200).map((l) => l.text).join("\n");

describe("#2765 per-judge proof provenance", () => {
  it("under the default, shows each judge and marks the one whose judgment doesn't decide", () => {
    const out = text(readiness(false, "accepted", "r1 accept"));
    expect(out).toContain("Judges · the item's latest judgment decides:");
    expect(out).toContain("review-r1@trial · ACCEPTED · judgment 2 · r1 accept");
    expect(out).toContain("review-r2@trial · REJECTED · judgment 1 · not deciding (a later judgment decides the item) · r2 reject");
    expect(out).toContain("Latest judgment on this item (corrections chain on it):");
  });

  it("with everyJudge, says every judge must accept and shows each one deciding", () => {
    const out = text(readiness(true, "rejected", "review-r2@trial: r2 reject"));
    expect(out).toContain("Judges · every judge must accept:");
    expect(out).toContain("review-r2@trial · REJECTED · judgment 1 · r2 reject");
    expect(out).not.toContain("not deciding");
  });

  it("an older daemon that serves no per-judge view shows what it did before", () => {
    const r = readiness(false, "accepted", "r1 accept");
    delete r.items[0]!.judges;
    const out = text(r);
    expect(out).not.toContain("Judges ·");
    expect(out).not.toContain("Latest judgment on this item");
  });
});
