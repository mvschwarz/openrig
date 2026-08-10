// P34 — THE ENUMERATION GUARD: the set of in-transaction queue writers is CLOSED.
//
// Ruled by dev50-planner 17:57Z, cleared by dev50-guard 18:03Z.
//
// WHY IT KEYS ON THE CALL SITE AND NOT ON THE VALUE.
// The obvious phrasing — "every caller that can pass a TERMINAL state to
// updateWithinTransaction must be sanctioned" — is a VALUE-TRACKING property, and
// value tracking is not locally decidable:
//     const s = cond ? "done" : "blocked";   updateWithinTransaction({ state: s })
// defeats it, as do assignment, loop and initializer forms. That is the exact
// property review50-r2 falsified the W2b rev-1 guard on, with four ordinary
// TypeScript shapes returning violations=[].
//
// So this guard asks only a SYNTACTIC question: does this file call
// updateWithinTransaction at all? Fully decidable, and it cannot be defeated by
// how the state value is computed.
//
// IT DELIBERATELY OVER-APPROXIMATES. Park-only callers are listed too, each entry
// naming which case it is. Over-approximation costs one explicit line when a
// writer is added; under-approximation fails SILENTLY, which is the whole defect
// class this atom exists to close. A new writer cannot appear without a human
// writing down what it is.
//
// WHAT THIS GUARD DOES NOT CLAIM. It is a CHECK-TIME guard, not runtime
// enforcement. better-sqlite3 exposes no commit hook and each writer owns its own
// db.transaction, so a fourth writer can be FIXED at runtime but never CAUGHT
// there. The honest wave claim is therefore permanent: "impossible via the queue's
// terminal verbs; a fourth writer FAILS THE GUARD at check time; not
// runtime-enforced." Never bare "impossible".

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Which case each sanctioned caller is. The label is the point: adding a writer
 *  means stating what it does, not just silencing a checker. */
//
// NOT listed, deliberately: domain/queue-repository.ts. It DEFINES
// updateWithinTransaction and reaches its own write path through the private
// updateInTransactionalContext — it is the definer, never an external caller. The
// exact-count assertion below caught this on the guard's first run, when the list
// had been written from memory rather than from the corpus: four entries against
// three real call sites. If the repository ever does call the primitive on itself,
// that is a NEW call site and this guard will demand it be written down.
const SANCTIONED: Record<string, string> = {
  "domain/mission-control/mission-control-write-contract.ts":
    "P34 site: terminal close + successor create (route/handoff); also a non-terminal park (hold) and resolve",
  "domain/workflow-projector.ts":
    "P34 sites: the routes branch and the failed branch (mutually exclusive); also the gate park",
  "domain/workflow-runtime.ts":
    "P34 sites: route, and the resume redrive; also the entry-gate park, the route re-park, and the no-successor exception closes",
};

const SRC = join(import.meta.dirname, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

interface Corpus {
  path: string;
  content: string;
}

interface GuardResult {
  violations: string[];
  examined: number;
  /** Set when the guard examined NO call sites at all — a check that verified
   *  nothing must not report the same green as one that verified everything. */
  vacuous: boolean;
}

/** The guard itself: a pure function over a corpus, so it can be shown FIRING on a
 *  synthetic fourth writer without adding one to src/. */
export function checkCallSites(corpus: Corpus[], sanctioned: Record<string, string>): GuardResult {
  const violations: string[] = [];
  let examined = 0;
  for (const { path, content } of corpus) {
    if (!/\.updateWithinTransaction\s*\(/.test(content)) continue;
    examined += 1;
    if (!(path in sanctioned)) violations.push(path);
  }
  return { violations, examined, vacuous: examined === 0 };
}

function realCorpus(): Corpus[] {
  return walk(SRC).map((full) => ({
    path: full.slice(SRC.length + 1).split("\\").join("/"),
    content: readFileSync(full, "utf8"),
  }));
}

describe("P34 RED 3 — the enumeration guard", () => {
  it("the LIVE set of in-transaction queue writers is exactly the sanctioned set", () => {
    const result = checkCallSites(realCorpus(), SANCTIONED);
    expect(result.violations).toEqual([]);
    // Guards against the sanctioned list rotting into a superset of reality: if a
    // listed writer is deleted or renamed, the count drops and this fails, forcing
    // the list to be re-stated rather than quietly over-permitting.
    expect(result.examined).toBe(Object.keys(SANCTIONED).length);
  });

  it("FIRES on a synthetic FOURTH writer added outside the primitive — demonstrated, not merely present", () => {
    const corpus = [
      ...realCorpus(),
      {
        path: "domain/rogue-writer.ts",
        content: `
          export class RogueWriter {
            close(id: string) {
              // A fourth writer closing terminally + creating a successor, with no
              // stageWakeIntent and no seam assert. The state is computed, so a
              // value-tracking guard would return violations=[] here.
              const state = Math.random() > 0.5 ? "done" : "blocked";
              this.queueRepo.updateWithinTransaction({ qitemId: id, state });
              this.queueRepo.createWithinTransaction({ body: "successor" });
            }
          }
        `,
      },
    ];
    const result = checkCallSites(corpus, SANCTIONED);
    expect(result.violations).toEqual(["domain/rogue-writer.ts"]);
  });

  it("a sanctioned entry does not license OTHER files — the allowlist is per-path, not a pattern", () => {
    const corpus = [
      {
        path: "domain/workflow-projector-v2.ts",
        content: `this.queueRepo.updateWithinTransaction({ state: "done" });`,
      },
    ];
    // A near-miss name must not inherit the sanction of workflow-projector.ts.
    expect(checkCallSites(corpus, SANCTIONED).violations).toEqual(["domain/workflow-projector-v2.ts"]);
  });
});

describe("P34 RED 5 — KNOWN-NEGATIVE: a guard that examines nothing must FAIL", () => {
  it("reports vacuous on an empty corpus rather than a clean pass", () => {
    // A check that verified nothing reports the same green as one that verified
    // everything. This is what tells them apart — and it is why the live test above
    // asserts an exact `examined` count rather than only an empty violations list.
    const result = checkCallSites([], SANCTIONED);
    expect(result.violations).toEqual([]);
    expect(result.vacuous).toBe(true);
  });

  it("reports vacuous when the corpus has files but NONE call the primitive", () => {
    const result = checkCallSites(
      [{ path: "domain/unrelated.ts", content: "export const x = 1;" }],
      SANCTIONED,
    );
    expect(result.vacuous).toBe(true);
  });

  it("the LIVE run is NOT vacuous — the real corpus really was examined", () => {
    expect(checkCallSites(realCorpus(), SANCTIONED).vacuous).toBe(false);
  });
});
