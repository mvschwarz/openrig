import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_RUNG_RANK } from "../src/domain/activity-taxonomy.js";

// OPR.0.5.5.19 A9 — the explicit rejects, pinned so the next generation cannot
// re-derive them expensively (mini-req 9): transcript-quiescence NEVER becomes the
// activity oracle; pane-scraping stays fallback-tier only.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const domainDir = join(repoRoot, "packages", "daemon", "src", "domain");

describe("S19 A9 — rejected oracles stay rejected", () => {
  it("the rung set is CLOSED and contains no transcript-shaped rung", () => {
    expect(EVIDENCE_RUNG_RANK).toEqual(["self-report", "lifecycle-hooks", "window-sampling"]);
    for (const rung of EVIDENCE_RUNG_RANK) expect(rung).not.toMatch(/transcript/i);
  });

  it("no activity-domain source feeds transcript-derived evidence into the ladder (grep, scope named: packages/daemon/src/domain)", () => {
    // Scope: the domain layer, where the oracle and every evidence producer added by
    // this slice live. A hit = a `reportEvidence`/rung reference in the same file as
    // transcript vocabulary — reviewed by hand if this ever fires.
    const offenders: string[] = [];
    for (const file of readdirSync(domainDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(domainDir, file), "utf8");
      if (!src.includes("reportEvidence(")) continue;
      if (/transcript/i.test(src) && !/never a rung|REJECTED|reject/i.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("the sampling floor is the ONLY pane-derived rung, ranked last (pane reading never primary)", () => {
    expect(EVIDENCE_RUNG_RANK[EVIDENCE_RUNG_RANK.length - 1]).toBe("window-sampling");
  });

  it("the reference doc carries both dated reject receipts and the permitted refocus-cadence consumer", () => {
    const doc = readFileSync(join(repoRoot, "docs", "reference", "agent-state-taxonomy.md"), "utf8");
    expect(doc).toMatch(/transcript[- ]quiescence.*REJECTED/is);
    expect(doc).toMatch(/pane[- ]scraping.*REJECTED/is);
    expect(doc).toMatch(/refocus/i);
  });
});
