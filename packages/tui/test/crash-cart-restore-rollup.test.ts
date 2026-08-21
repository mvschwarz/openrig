// B1 (H4) — the restore rollup is PARSED and SUMMARIZED (not discarded). Discriminators: a mixed
// rollup surfaces verdict + counts + attention needs + not_attempted reason/remediation; malformed
// input is honest-null (no fabricated summary).
import { describe, it, expect } from "vitest";
import { parseRestoreRollup, summarizeRestoreRollup } from "../src/crash-cart/restore-rollup.js";

const mixedJson = JSON.stringify({
  verdict: "mixed",
  rollup: {
    counts: { fully_restored: 1, partially_restored: 0, failed: 1, not_attempted: 1 },
    sequence: [
      { rigId: "kernel", outcome: "fully_restored" },
      { rigId: "alpha", outcome: "failed" },
      { rigId: "beta", outcome: "not_attempted", reason: "no restore-usable snapshot for this rig", remediation: "take a snapshot" },
    ],
    attention_required: [{ rigId: "kernel", seat: "dev.guard", need: "run claude --resume and pick a session" }],
  },
});

describe("parseRestoreRollup", () => {
  it("parses a well-formed rollup payload into the model", () => {
    const m = parseRestoreRollup(mixedJson)!;
    expect(m.verdict).toBe("mixed");
    expect(m.counts).toEqual({ fully_restored: 1, partially_restored: 0, failed: 1, not_attempted: 1 });
    expect(m.attention).toEqual([{ rigId: "kernel", seat: "dev.guard", need: "run claude --resume and pick a session" }]);
    expect(m.notAttempted).toEqual([{ rigId: "beta", reason: "no restore-usable snapshot for this rig", remediation: "take a snapshot" }]);
  });

  it("returns null on malformed / non-rollup input (honest silence, never a fabricated summary)", () => {
    expect(parseRestoreRollup("")).toBeNull();
    expect(parseRestoreRollup("not json")).toBeNull();
    expect(parseRestoreRollup(JSON.stringify({ error: "still running" }))).toBeNull();
    expect(parseRestoreRollup(JSON.stringify({ verdict: "x" }))).toBeNull(); // no rollup
  });
});

describe("summarizeRestoreRollup — one honest notice line", () => {
  it("carries verdict + counts + attention needs + not_attempted reason/remediation", () => {
    const line = summarizeRestoreRollup(parseRestoreRollup(mixedJson)!);
    expect(line).toContain("Fleet restore: mixed");
    expect(line).toContain("1 restored");
    expect(line).toContain("1 failed");
    expect(line).toContain("1 not-attempted");
    expect(line).toContain("dev.guard@kernel — run claude --resume and pick a session");
    expect(line).toContain("beta — no restore-usable snapshot for this rig (take a snapshot)");
  });

  it("all-clean rollup: no attention / not-attempted clauses", () => {
    const line = summarizeRestoreRollup(
      parseRestoreRollup(
        JSON.stringify({
          verdict: "all_fully_restored",
          rollup: { counts: { fully_restored: 3, partially_restored: 0, failed: 0, not_attempted: 0 }, sequence: [], attention_required: [] },
        }),
      )!,
    );
    expect(line).toContain("Fleet restore: all_fully_restored — 3 restored");
    expect(line).not.toContain("attention:");
    expect(line).not.toContain("not attempted:");
  });
});
