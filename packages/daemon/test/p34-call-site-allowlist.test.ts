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

// ── REV 2 (review-r2 HIGH-1) — THE GRANULARITY FIX ───────────────────────────
// Rev 1 sanctioned FILENAMES and counted FILES. That is coarser than the thing it
// constrains: an added unguarded call INSIDE an already-sanctioned file left the
// file count unchanged and stayed GREEN — the guard could not fail for the very
// case it exists to catch. It also matched a raw regex over the whole file, so
// COMMENTS mentioning the primitive inflated the count and alias bindings escaped
// it entirely.
//
// Rev 2 constrains CALL SITES. Each sanctioned entry declares HOW MANY sites that
// file may hold and why; any added, removed, or relocated call changes the count
// and fails BY NAME. Comment lines are excluded, alias bindings are counted, and
// the method DEFINITION is not a call site.
//
// Rev 1's counts were also simply wrong, which is its own evidence: it matched
// `.updateWithinTransaction(` including comment lines, reporting 4/3/2 where the
// real code holds 4/2/2 and queue-repository holds ZERO (line 1711 is the
// declaration). A guard whose measurement is off by a comment is not measuring
// the constraint.

/** Which case each sanctioned caller is, and how many call sites it may hold. The
 *  label is the point: adding a writer means stating what it does, not just
 *  silencing a checker. */
const SANCTIONED: Record<string, { sites: number; why: string }> = {
  "domain/mission-control/mission-control-write-contract.ts": {
    sites: 2,
    why: "P34 terminal close + successor create (route/handoff) at :160; the non-terminal resolve update at :415",
  },
  "domain/workflow-projector.ts": {
    sites: 4,
    why: "legacy terminal close + gate park; dependency-graph packet close + dependency-graph gate park (parallel successors remain in the same transaction)",
  },
  "domain/workflow-runtime.ts": {
    sites: 5,
    why: "entry-gate park; explicit abort closes every live packet; no-successor exception close; packet-addressed route close; route re-park",
  },
};

// NOT listed, deliberately: domain/queue-repository.ts. It DEFINES
// updateWithinTransaction and reaches its own write path through the private
// updateInTransactionalContext — definer, never caller, so it holds ZERO call
// sites. Rev 1 listed it and was caught by the count assertion. If the repository
// ever calls the primitive on itself, that is a NEW site and this guard demands it
// be written down.

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
  /** TOTAL CALL SITES examined — not files. The rev-1 defect was counting the
   *  coarser unit, which cannot notice a site added inside a counted file. */
  examined: number;
  vacuous: boolean;
}

/** Is this line comment-only? Cheap and line-oriented on purpose: a whole-file
 *  regex strip is what silently ate a real call while rev 2 was being written. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** Call sites of the primitive in one file's source.
 *  Counts:  `x.updateWithinTransaction(`      — the ordinary call
 *           `const { updateWithinTransaction }` / `= obj.updateWithinTransaction;`
 *                                             — ALIAS BINDINGS, which rev 1 missed
 *                                               entirely and which can call it later
 *  Excludes: comment lines, and the method DECLARATION itself. */
export function countCallSites(content: string): number {
  let n = 0;
  for (const line of content.split("\n")) {
    if (isCommentLine(line)) continue;
    if (/^\s*updateWithinTransaction\s*\(/.test(line)) continue; // the declaration
    for (const _ of line.matchAll(/\.updateWithinTransaction\s*\(/g)) n += 1;
    // Alias binding: the identifier appears WITHOUT being an immediate call on a
    // receiver — destructured, or captured into a variable for later invocation.
    if (/(?:\{[^}]*\bupdateWithinTransaction\b[^}]*\}\s*=)|(?:=\s*[\w.]*\.?updateWithinTransaction\s*[;,)])/.test(line)) {
      n += 1;
    }
  }
  return n;
}

/** The guard: a pure function over a corpus, so it can be shown FIRING without
 *  adding a rogue writer to src/. */
export function checkCallSites(
  corpus: Corpus[],
  sanctioned: Record<string, { sites: number; why: string }>,
): GuardResult {
  const violations: string[] = [];
  let examined = 0;
  for (const { path, content } of corpus) {
    const sites = countCallSites(content);
    if (sites === 0) {
      // A sanctioned entry that no longer holds any site is list ROT — the
      // allowlist would silently over-permit a file that stopped being a writer.
      if (path in sanctioned) violations.push(`stale-entry:${path} (sanctioned for ${sanctioned[path]!.sites}, holds 0)`);
      continue;
    }
    examined += sites;
    const entry = sanctioned[path];
    if (!entry) {
      violations.push(`unsanctioned-file:${path} (${sites} call site${sites === 1 ? "" : "s"})`);
    } else if (entry.sites !== sites) {
      // THE REV-1 GAP: this is the case a file-granular guard cannot see.
      violations.push(`count-mismatch:${path} (sanctioned ${entry.sites}, found ${sites})`);
    }
  }
  return { violations, examined, vacuous: examined === 0 };
}

function realCorpus(): Corpus[] {
  return walk(SRC).map((full) => ({
    path: full.slice(SRC.length + 1).split("\\").join("/"),
    content: readFileSync(full, "utf8"),
  }));
}

const TOTAL_SITES = Object.values(SANCTIONED).reduce((n, e) => n + e.sites, 0);

/** Rev 1's semantics, kept ONLY as a negative control: sanction filenames, count
 *  FILES. review-r2's HIGH-1 is that this cannot fail for a call added inside an
 *  already-sanctioned file. The test below proves that by running it. */
function checkFileGranular(corpus: Corpus[]): { violations: string[]; examined: number } {
  const violations: string[] = [];
  let examined = 0;
  for (const { path, content } of corpus) {
    if (!/\.updateWithinTransaction\s*\(/.test(content)) continue;
    examined += 1;
    if (!(path in SANCTIONED)) violations.push(path);
  }
  return { violations, examined };
}

/** The corpus with ONE extra call spliced into an already-sanctioned file — the
 *  exact shape rev 1 could not see. */
function corpusWithExtraCallInSanctionedFile(): Corpus[] {
  const corpus = realCorpus();
  const target = corpus.find((c) => c.path === "domain/workflow-projector.ts");
  if (!target) throw new Error("fixture precondition failed: sanctioned file not in corpus");
  return corpus.map((c) =>
    c === target
      ? {
          ...c,
          content:
            c.content +
            `\nfunction smuggledWriter(q: any, id: string) { q.updateWithinTransaction({ qitemId: id, state: "done" }); }\n`,
        }
      : c,
  );
}

describe("P34 RED 3 — the enumeration guard (rev 2: call-site granularity)", () => {
  it("the LIVE corpus matches the sanctioned set exactly, by CALL SITE", () => {
    const result = checkCallSites(realCorpus(), SANCTIONED);
    expect(result.violations).toEqual([]);
    // Counts SITES, not files. 11 sites across 3 files.
    expect(result.examined).toBe(TOTAL_SITES);
    expect(result.examined).toBe(11);
    expect(result.vacuous).toBe(false);
  });

  it("HIGH-1: FIRES BY NAME on a call added inside an ALREADY-SANCTIONED file", () => {
    const result = checkCallSites(corpusWithExtraCallInSanctionedFile(), SANCTIONED);
    expect(result.violations).toEqual([
      "count-mismatch:domain/workflow-projector.ts (sanctioned 4, found 5)",
    ]);
  });

  it("HIGH-1 negative control: the REV-1 file-granular guard MISSES that same call", () => {
    // Disabling the granularity — reverting to rev 1's semantics — and watching the
    // intended violation NOT be caught is what makes the fix evidence rather than
    // assertion. A control never observed failing is not evidence.
    const mutated = corpusWithExtraCallInSanctionedFile();
    expect(checkFileGranular(mutated).violations).toEqual([]); // rev 1: silent
    expect(checkCallSites(mutated, SANCTIONED).violations).toHaveLength(1); // rev 2: loud
  });

  it("FIRES on a synthetic FOURTH writer in a NEW file, with its state computed", () => {
    const corpus = [
      ...realCorpus(),
      {
        path: "domain/rogue-writer.ts",
        content: `
          export class RogueWriter {
            close(id: string) {
              const state = Math.random() > 0.5 ? "done" : "blocked";
              this.queueRepo.updateWithinTransaction({ qitemId: id, state });
              this.queueRepo.createWithinTransaction({ body: "successor" });
            }
          }
        `,
      },
    ];
    // The state is computed exactly the way that defeated the W2b rev-1 guard.
    expect(checkCallSites(corpus, SANCTIONED).violations).toEqual([
      "unsanctioned-file:domain/rogue-writer.ts (1 call site)",
    ]);
  });

  it("counts ALIAS BINDINGS, which rev 1 missed entirely", () => {
    const aliased = [
      {
        path: "domain/aliaser.ts",
        content: `const { updateWithinTransaction } = queueRepo;\nupdateWithinTransaction({ state: "done" });`,
      },
    ];
    expect(checkCallSites(aliased, SANCTIONED).violations).toEqual([
      "unsanctioned-file:domain/aliaser.ts (1 call site)",
    ]);
  });

  it("does NOT count comment mentions — a doc reference is not a call site", () => {
    const corpus = realCorpus().map((c) =>
      c.path === "domain/workflow-projector.ts"
        ? { ...c, content: c.content + "\n// see QueueRepository.updateWithinTransaction for the contract\n" }
        : c,
    );
    // Rev 1 inflated its counts exactly this way.
    expect(checkCallSites(corpus, SANCTIONED).violations).toEqual([]);
  });

  it("FIRES on list ROT — a sanctioned file that no longer calls the primitive", () => {
    const corpus = realCorpus().map((c) =>
      c.path === "domain/workflow-projector.ts"
        ? { ...c, content: c.content.split(".updateWithinTransaction(").join(".somethingElse(") }
        : c,
    );
    expect(checkCallSites(corpus, SANCTIONED).violations).toEqual([
      "stale-entry:domain/workflow-projector.ts (sanctioned for 4, holds 0)",
    ]);
  });

  it("a near-miss filename does not inherit a sanction — the allowlist is per-path", () => {
    const corpus = [
      {
        path: "domain/workflow-projector-v2.ts",
        content: `this.queueRepo.updateWithinTransaction({ state: "done" });`,
      },
    ];
    expect(checkCallSites(corpus, SANCTIONED).violations).toEqual([
      "unsanctioned-file:domain/workflow-projector-v2.ts (1 call site)",
    ]);
  });
});

describe("P34 RED 5 — KNOWN-NEGATIVE: a guard that examines nothing must FAIL", () => {
  it("reports vacuous on an empty corpus rather than a clean pass", () => {
    const result = checkCallSites([], SANCTIONED);
    expect(result.violations).toEqual([]);
    expect(result.vacuous).toBe(true);
  });

  it("reports vacuous when files exist but NONE call the primitive", () => {
    expect(
      checkCallSites([{ path: "domain/unrelated.ts", content: "export const x = 1;" }], SANCTIONED).vacuous,
    ).toBe(true);
  });

  it("the LIVE run is NOT vacuous and examined the expected number of SITES", () => {
    const live = checkCallSites(realCorpus(), SANCTIONED);
    expect(live.vacuous).toBe(false);
    expect(live.examined).toBe(11);
  });
});
