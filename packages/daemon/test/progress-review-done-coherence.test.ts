// VM-006 (progress-review-done-coherence) — the Progress↔Review "done"
// union: buildAcceptance derives done = checkboxTicked OR qaVerified for
// proof-contract rows, via Review's OWN exported trio + the ONE proof-io
// reader (arch A1). Plan of record: IMPLEMENTATION-PLAN-vm006 v1.2
// (sha256 8ad843f8…); PRD 00ef4e18…; arch Cell A 30557c39….
//
// FIXTURE PROVENANCE (frozen, do-not-hand-mint): every byte under
// test/fixtures/progress-review-done-coherence/03-shared-by-label/ is
// copied VERBATIM from the frozen dogfood workspace snapshot
// release-0.4.7-workspace.tar.gz (sha256
// 69d20c6a0a29edd9c76d9a1e3a10325a23fb3d8b28898c4581f1e00091682452, at
// dogfood-evidence/release-0.4.7/revalidation-704ddb58/review-tab-fixset/),
// path missions/release-0.4.7/slices/03-shared-by-label/. Copied files +
// md5: README.md d6280fbf3c760af7459567d88569b5bc · IMPLEMENTATION-PRD.md
// 4020213ba8d6bec79f58fc062b8e648a · PROGRESS.md
// 543f616d1a2fa57d7d9b5c6095e0c7cf · PROOF.md
// c72cf0f5357367b3d838347c624b7fa2 · proof/qa-PASS-shared-by-label.md
// 804e1210d097cb7a0b208c9d858b2c66. The snapshot's binaries (mockups/*,
// proof/*.png) are omitted: neither derivation reads them (buildAcceptance
// scans only the four candidate .md names; readProofArtifacts filters
// proof/*.md). V2/V7's vectors are minimal DERIVED fixtures — documented
// per-test edits atop these frozen bytes, per plan §D.
//
// TWO differential references (both must hold; §D contract):
//
//  (a) vs BASE 704ddb58 — the feature does not exist at all. Every
//      NEW-BEHAVIOR assert is assertion-shaped RED there, never a crash
//      (every static import below exists at base, so this file LOADS):
//        V1 RED (base: total 13 done 7 pct 54, six ACTIVE; doneVia absent) ·
//        V2 RED (done true at base but doneVia undefined) · V3/V4 GREEN both
//        ends (protective) · V6′ GREEN both ends (delegation canary) ·
//        V7a RED · V7b RED via its doneItems context assert (its no-false-join
//        CORE assert is base-green protective) · V8 GREEN except (c)'s
//        doneVia stamp · FS-1c RED (0 readdirs vs 1); FS-1a/b GREEN both ends.
//
//  (b) vs FROZEN PREDECESSOR 0ec6411c — the B1 collision reference. It has
//      the feature but joins on a comparator that STRIPS inline images, which
//      is COARSER than the acceptance dedup key (raw trim+casefold). A coarser
//      join relation maps two distinct rows onto one obligation:
//        RC1 RED at predecessor (a non-contract row is FALSE-LIFTED) ·
//        RC2 RED at predecessor (an UNVERIFIED second ordinal is lifted) ·
//        AMB RED at predecessor (a genuinely ambiguous row is lifted anyway).
//      v1.4 (arch PIN-C Option-A) joins on the RAW authored text on both
//      sides, so join-relation == dedup-relation and the collisions become
//      distinctions. INV pins the count invariant that falls out of it.
//
// PROOF STATUS: these dispositions are the ASSERTED §D contract and are TO BE
// CONFIRMED by the VM differential run (base-RED, predecessor-RED, successor-
// GREEN). They are NOT stamped as confirmed here — no leg is claimed green
// until its recorded artifact lands.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";

// FS-1 instrumentation: `vi.spyOn` cannot redefine an ESM builtin namespace
// export, so `readdirSync` is wrapped via the module-mock passthrough — every
// other fs export stays the real implementation, and node_modules (e.g.
// better-sqlite3) are externalized so only in-graph product code sees the
// wrapper. Behavior is unchanged; the wrapper only records calls.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodePath from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { ReviewGatherer } from "../src/domain/review/gather.js";
import { extractProofContract } from "../src/domain/review/compose.js";

// BASE-COMPAT (the VM-005 §D-bis lesson, honored by construction): every
// static import above exists at base 704ddb58, so this file LOADS at base and
// the RED leg fails by ASSERTION, never by import crash. No candidate-only
// symbol is imported.
//
// `textKey` below is this suite's ORACLE — a test-local restatement of the
// v1.4 join key (arch PIN-C Option-A): trim + casefold on the RAW authored
// text, with NO image strip and NO whitespace collapse, because the key must
// equal the acceptance dedup expression. Restating it here rather than
// importing the product helper keeps the oracle independent of the code under
// test. The PRODUCT key is exercised end-to-end through the projector; RC1/RC2
// are precisely the vectors a COARSER (image-stripping) join key fails.
function textKey(text: string): string {
  return text.trim().toLowerCase();
}

const SLICE = "03-shared-by-label";
const FIXTURE_DIR = nodePath.resolve(
  import.meta.dirname,
  "fixtures",
  "progress-review-done-coherence",
  SLICE,
);

describe("VM-006 — Progress↔Review done coherence (union in buildAcceptance)", () => {
  let db: Database.Database;
  let slicesRoot: string;
  let cleanupRoot: string;
  let indexer: SliceIndexer;
  let projector: SliceDetailProjector;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      missionControlActionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanupRoot = mkdtempSync(join(tmpdir(), "vm006-coherence-"));
    slicesRoot = join(cleanupRoot, "slices");
    // The frozen fixture is copied per test so vectors can derive from it
    // without ever mutating the committed bytes.
    cpSync(FIXTURE_DIR, join(slicesRoot, SLICE), { recursive: true });
    indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
    projector = new SliceDetailProjector({ db, indexer, workflowSpecCache: new WorkflowSpecCache(db) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(cleanupRoot, { recursive: true, force: true });
  });

  const sliceDir = () => join(slicesRoot, SLICE);
  const fileOf = (rel: string) => join(sliceDir(), rel);
  const editFile = (rel: string, edit: (content: string) => string) =>
    writeFileSync(fileOf(rel), edit(readFileSync(fileOf(rel), "utf8")));

  function acceptanceOf() {
    const slice = indexer.get(SLICE);
    expect(slice, `slice ${SLICE} must index`).toBeTruthy();
    return projector.project(slice!).acceptance;
  }

  /** The six frozen contract obligations keyed the way the join keys them —
   *  derived from the fixture PRD via the product's own extractor (V4 is
   *  exactly this cross-derivation agreement).
   *
   *  BASE-COMPAT: `rawText` is a successor-only field, so at base/predecessor
   *  it is undefined and we fall back to `text`. That fallback keeps this
   *  helper from throwing a TypeError there — the differential legs must fail
   *  by ASSERTION, never by crash — and on the frozen fixture (whose contract
   *  rows carry no inline image) the two carriers are byte-identical anyway,
   *  so the set is the same six either way. */
  function contractTextSet(): Set<string> {
    const promised = extractProofContract(readFileSync(fileOf("IMPLEMENTATION-PRD.md"), "utf8"));
    return new Set(promised.map((p) => textKey((p as { rawText?: string }).rawText ?? p.text)));
  }

  /** Review's OWN verified count on the current fixture bytes — the ceiling
   *  the Progress lift may never exceed (pm FR-2 invariant 2). */
  function reviewVerifiedCount(): number {
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => "2026-07-11T00:00:00.000Z" });
    const composed = gatherer.composeSlice(SLICE);
    expect(composed).toBeTruthy();
    return composed!.delivered.items.filter((i) => i.verified === "verified").length;
  }

  /** Replace the six frozen contract rows — in BOTH carriers (the PRD is
   *  Review's source; the README rows are the citations that survive the
   *  README-first dedup) — with an exact vector, and verify ONLY the given
   *  1-based ordinals. Ordinals (not text) are used on the evidence side
   *  precisely because `refMatches` also matches by exact text: with duplicate
   *  authored texts a text-evidence would verify BOTH ordinals and destroy the
   *  vector. */
  function contractVector(rows: string[], verifiedOrdinals: string[]): void {
    const block = rows.map((r) => `- [ ] ${r}`).join("\n");
    const replaceContract = (c: string) => {
      const start = c.indexOf("- [ ] **1. Shared card label**");
      const lastRow = c.indexOf("- [ ] **6. Long-name truncation**");
      const end = c.indexOf("\n", lastRow);
      return c.slice(0, start) + block + c.slice(end);
    };
    editFile("IMPLEMENTATION-PRD.md", replaceContract);
    editFile("README.md", replaceContract);
    editFile("proof/qa-PASS-shared-by-label.md", (c) =>
      c.replace(
        /evidences:\n(?:\s+- "\d"\n)+/,
        `evidences:\n${verifiedOrdinals.map((o) => `  - "${o}"\n`).join("")}`,
      ));
  }

  // --- V1 · money-shot: the six-verdict fixture reads 13/13, zero ACTIVE,
  //     agreeing with Review's 6 verified ---------------------------------

  it("V1: six QA-verified contract rows lift — 13/13, zero ACTIVE, agrees with Review", () => {
    const a = acceptanceOf();
    expect(a.totalItems).toBe(13);
    expect(a.doneItems).toBe(13);
    expect(a.percentage).toBe(100);
    expect(a.items.filter((i) => !i.done)).toEqual([]);

    const lifted = a.items.filter((i) => i.doneVia === "qa-verdict");
    expect(lifted).toHaveLength(6);
    // The lifted rows are the contract rows — which cite README.md (the
    // README-first dedup), NOT the PRD: the join is text-set, never source.file.
    for (const row of lifted) expect(row.source.file).toBe("README.md");

    // Agreement with Review, from Review's own composition on the same bytes:
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => "2026-07-11T00:00:00.000Z" });
    const composed = gatherer.composeSlice(SLICE);
    expect(composed).toBeTruthy();
    const verified = composed!.delivered.items.filter((i) => i.verified === "verified");
    expect(verified).toHaveLength(6);
    expect(lifted.length).toBe(verified.length);
  });

  // --- V2 · union: a hand-ticked contract row with NO QA verdict stays done ---

  it("V2: hand-ticked contract row with no verdict stays done, doneVia=checkbox (derived fixture: README row 1 ticked, proof/ removed)", () => {
    editFile("README.md", (c) =>
      c.replace("- [ ] **1. Shared card label**", "- [x] **1. Shared card label**"));
    rmSync(join(sliceDir(), "proof"), { recursive: true, force: true });

    const a = acceptanceOf();
    const row1 = a.items.find((i) => i.text.includes("1. Shared card label"));
    expect(row1).toBeTruthy();
    expect(row1!.done).toBe(true);
    expect(row1!.doneVia).toBe("checkbox");
    // The other five contract rows honestly stay undone (no artifacts).
    expect(a.doneItems).toBe(8);
    expect(a.totalItems).toBe(13);
  });

  // --- V3 · FR-2: non-contract rows byte-identical (text/source/done) ---

  it("V3: the seven PROGRESS.md rows keep text, source, and done exactly as authored", () => {
    // Independent oracle: re-parse the frozen PROGRESS bytes with the
    // projector's own checkbox grammar.
    const lines = readFileSync(fileOf("PROGRESS.md"), "utf8").split("\n");
    const expected: Array<{ text: string; line: number; done: boolean }> = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^\s*-?\s*\[(\s|x|X)\]\s+(.+)$/);
      if (m) expected.push({ text: m[2]!.trim(), line: i + 1, done: m[1]!.toLowerCase() === "x" });
    }
    expect(expected).toHaveLength(7);

    const a = acceptanceOf();
    const progressRows = a.items.filter((i) => i.source.file === "PROGRESS.md");
    expect(progressRows.map((i) => ({ text: i.text, line: i.source.line, done: i.done })))
      .toEqual(expected);
  });

  // --- V4 · agreement vector: both tabs enumerate the same six ---

  it("V4: acceptance contract-subset text-set ≡ DELIVERED promised text-set (six each)", () => {
    const promised = contractTextSet();
    expect(promised.size).toBe(6);

    const a = acceptanceOf();
    const acceptanceContractTexts = new Set(
      a.items
        .map((i) => textKey(i.text))
        .filter((t) => promised.has(t)),
    );
    expect(acceptanceContractTexts).toEqual(promised);
  });

  // --- V6′ · A1 delegation canary: Review's artifact-derived output is
  //     pinned across the verbatim proof-io extraction ---------------------

  it("V6′: gather's proof-artifact output is pinned on the frozen fixture (delegation canary)", () => {
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => "2026-07-11T00:00:00.000Z" });
    const composed = gatherer.composeSlice(SLICE);
    expect(composed).toBeTruthy();
    const items = composed!.delivered.items;
    expect(items).toHaveLength(6);
    for (const item of items) expect(item.verified).toBe("verified");
    // The artifact set: exactly the one .md drop feeds every deliverable's
    // QA note (mirror semantics: .md filter, sort, mtime→ISO,
    // try/catch-skip — one implementation, provably still feeding Review).
    expect(items[0]!.note).toContain("Inspected the committed diff");
    expect(composed!.delivered.proofDirPath).toContain(`${SLICE}/proof`);
  });

  // --- V7 · PIN C image-ref join, BOTH directions ---

  it("V7a: a contract row authored with a real ![shot](…) still joins and lifts", () => {
    // Derived fixture: contract row 6 gains a real image ref in BOTH carriers
    // (PRD = Review's source; README = the surviving acceptance citation).
    const addShot = (c: string) =>
      c.replace(
        /- \[ \] \*\*6\. Long-name truncation\*\* — ([^\n]+)/,
        "- [ ] **6. Long-name truncation** — $1 ![shot](proof/qa-delivered-shared-by-label.png)",
      );
    editFile("README.md", addShot);
    editFile("IMPLEMENTATION-PRD.md", addShot);

    const a = acceptanceOf();
    const row6 = a.items.find((i) => i.text.includes("6. Long-name truncation"));
    expect(row6).toBeTruthy();
    expect(row6!.done).toBe(true);
    expect(row6!.doneVia).toBe("qa-verdict");
    expect(a.doneItems).toBe(13);
  });

  it("V7b: a non-contract row that merely contains an image is NOT lifted (no false join)", () => {
    editFile("README.md", (c) =>
      c + "\n## Follow-ups\n\n- [ ] Extra gallery polish pass ![screenshot](mockups/shared-by-label.png)\n");

    const a = acceptanceOf();
    const extra = a.items.find((i) => i.text.includes("Extra gallery polish pass"));
    expect(extra).toBeTruthy();
    expect(extra!.done).toBe(false);
    expect(extra!.doneVia).toBeUndefined();
    expect(a.totalItems).toBe(14);
    expect(a.doneItems).toBe(13);
  });

  // --- V8 · degrade-safe: every absence is a no-op, never a throw ---

  it("V8a: no PRD ⇒ no contract ⇒ pure tick-state, no doneVia, no throw", () => {
    rmSync(fileOf("IMPLEMENTATION-PRD.md"));
    const a = acceptanceOf();
    expect(a.totalItems).toBe(13);
    expect(a.doneItems).toBe(7);
    expect(a.items.every((i) => i.doneVia === undefined)).toBe(true);
  });

  it("V8b: PRD without a Proof contract section ⇒ no-op, no doneVia", () => {
    editFile("IMPLEMENTATION-PRD.md", (c) => c.replace("## Proof contract", "## Notes"));
    const a = acceptanceOf();
    expect(a.totalItems).toBe(13);
    expect(a.doneItems).toBe(7);
    expect(a.items.every((i) => i.doneVia === undefined)).toBe(true);
  });

  it("V8c: authored contract but no proof/ dir ⇒ no lift, no throw; ticked rows stamp checkbox", () => {
    rmSync(join(sliceDir(), "proof"), { recursive: true, force: true });
    const a = acceptanceOf();
    expect(a.totalItems).toBe(13);
    expect(a.doneItems).toBe(7);
    const promised = contractTextSet();
    for (const item of a.items) {
      if (promised.has(textKey(item.text))) {
        expect(item.done).toBe(false);
        expect(item.doneVia).toBeUndefined();
      } else {
        expect(item.done).toBe(true);
        expect(item.doneVia).toBe("checkbox");
      }
    }
  });

  it("V8d: placeholder-only contract extracts to [] ⇒ no-op, no doneVia", () => {
    // Replace the PRD's six authored contract rows with one scaffold
    // placeholder row (the bracket-wrapped template grammar).
    editFile("IMPLEMENTATION-PRD.md", (c) => {
      const head = c.slice(0, c.indexOf("## Proof contract"));
      const tail = c.slice(c.indexOf("## Surface"));
      return head + "## Proof contract\n\n- [ ] [Observable outcome the operator can verify]\n\n" + tail;
    });
    const a = acceptanceOf();
    // The README still carries the six real rows as plain unticked items.
    expect(a.totalItems).toBe(13);
    expect(a.doneItems).toBe(7);
    expect(a.items.every((i) => i.doneVia === undefined)).toBe(true);
  });

  // --- B1 COLLISION REGRESSIONS (RED at frozen predecessor 0ec6411c) -------
  //
  // The predecessor joined the STRIPPED promised text against the RAW row text
  // through an image-stripping comparator. That relation is strictly COARSER
  // than the acceptance dedup key, and a coarser join collapses distinct rows
  // onto one obligation. v1.4 keys BOTH sides on the raw authored text, so the
  // join relation IS the dedup relation and these collisions cannot form.

  it("RC1: a non-contract row whose text equals a contract row's STRIPPED text is NOT lifted", () => {
    // Give contract row 6 a real inline image in both carriers. Its stripped
    // text is now a strict prefix-identity of a plain row we then author — the
    // exact pair an image-stripping join key collapses together.
    const addShot = (c: string) =>
      c.replace(
        /- \[ \] \*\*6\. Long-name truncation\*\* — ([^\n]+)/,
        "- [ ] **6. Long-name truncation** — $1 ![shot](proof/qa-delivered-shared-by-label.png)",
      );
    editFile("README.md", addShot);
    editFile("IMPLEMENTATION-PRD.md", addShot);

    // The stripped text, taken from the product's own extractor (`text` exists
    // at base, predecessor and successor — so this stays assertion-shaped).
    const promised = extractProofContract(readFileSync(fileOf("IMPLEMENTATION-PRD.md"), "utf8"));
    const row6 = promised.find((p) => p.text.includes("6. Long-name truncation"));
    expect(row6, "contract row 6 must extract").toBeTruthy();
    expect(row6!.text).not.toContain("![shot]"); // stripped carrier
    // A NON-contract follow-up row authored with exactly those stripped bytes.
    editFile("README.md", (c) => `${c}\n## Follow-ups\n\n- [ ] ${row6!.text}\n`);

    const a = acceptanceOf();
    // Two distinct acceptance rows exist: the image-bearing contract row and
    // the plain follow-up. They differ RAW, so the dedup keeps both.
    const plain = a.items.filter((i) => i.text === row6!.text);
    expect(plain, "the plain follow-up row survives dedup").toHaveLength(1);
    const contractRow = a.items.find((i) => i.text.includes("6. Long-name truncation") && i.text.includes("![shot]"));
    expect(contractRow, "the image-bearing contract row survives dedup").toBeTruthy();

    // THE DEFECT: the predecessor lifts the plain row because both collapse to
    // one stripped key. It is not an obligation and must never be lifted.
    expect(plain[0]!.done).toBe(false);
    expect(plain[0]!.doneVia).toBeUndefined();
    // ...while the genuine contract row still lifts (no under-count).
    expect(contractRow!.done).toBe(true);
    expect(contractRow!.doneVia).toBe("qa-verdict");

    // INV: the lift can never outrun Review's verified count.
    const lifted = a.items.filter((i) => i.doneVia === "qa-verdict").length;
    expect(lifted).toBeLessThanOrEqual(reviewVerifiedCount());
  });

  it("RC2: two contract rows differing ONLY by image ref — only the VERIFIED ordinal lifts", () => {
    const body = "**D. Duplicate obligation** — identical authored text, different planned shot";
    contractVector(
      [`${body} ![a](mockups/one.png)`, `${body} ![b](mockups/two.png)`],
      ["1"], // ordinal 1 only — ordinal 2 is promised but NOT verified
    );

    const a = acceptanceOf();
    const first = a.items.find((i) => i.text.includes("![a](mockups/one.png)"));
    const second = a.items.find((i) => i.text.includes("![b](mockups/two.png)"));
    expect(first, "both rows survive dedup (raw texts differ)").toBeTruthy();
    expect(second).toBeTruthy();

    // Under raw keys the two obligations are DISTINCT, so the verified one
    // lifts and the unverified one honestly stays ACTIVE. The predecessor's
    // stripped key made them one obligation and lifted BOTH — reporting work
    // as QA-verified that QA never verified.
    expect(first!.done).toBe(true);
    expect(first!.doneVia).toBe("qa-verdict");
    expect(second!.done).toBe(false);
    expect(second!.doneVia).toBeUndefined();

    // INV: exactly one lift, and Review verifies exactly one.
    const lifted = a.items.filter((i) => i.doneVia === "qa-verdict").length;
    expect(lifted).toBe(1);
    expect(lifted).toBeLessThanOrEqual(reviewVerifiedCount());
  });

  it("AMB: two BYTE-IDENTICAL authored contract lines ⇒ the 1:1 gate lifts NOTHING (no throw)", () => {
    // The genuinely ambiguous case — the gate's live purpose. Two identical
    // obligations, one verified: nothing distinguishes which row the verdict
    // belongs to, so fail closed. Stay-ACTIVE beats a coin-flip lift.
    const body = "**D. Ambiguous obligation** — byte-identical authored line";
    contractVector([body, body], ["1"]);

    const a = acceptanceOf();
    // The two identical README rows dedup to ONE acceptance row...
    const rows = a.items.filter((i) => i.text === body);
    expect(rows).toHaveLength(1);
    // ...but the key still reaches TWO obligations, so the association is not
    // 1:1 and the lift is refused.
    expect(rows[0]!.done).toBe(false);
    expect(rows[0]!.doneVia).toBeUndefined();

    const lifted = a.items.filter((i) => i.doneVia === "qa-verdict").length;
    expect(lifted).toBe(0);
    expect(lifted).toBeLessThanOrEqual(reviewVerifiedCount());
  });

  it("INV: on the frozen six-verdict fixture the lift count equals Review's verified count", () => {
    const a = acceptanceOf();
    const lifted = a.items.filter((i) => i.doneVia === "qa-verdict").length;
    const verified = reviewVerifiedCount();
    expect(lifted).toBe(6);
    expect(verified).toBe(6);
    expect(lifted).toBeLessThanOrEqual(verified);
  });

  // --- FS-1 · the IO guard: proof/ is read only when it can lift ---

  /** Calls to readdirSync targeting THIS slice's proof dir since the last
   *  clear (indexing happens before the clear — only project() is counted).
   *  Scoped to the PLAIN-STRING signature (`readdirSync(dir)`) —
   *  readProofArtifacts' exact call shape — because the projector's Docs
   *  tree (buildDocsTree) ALREADY walks the whole slice dir including
   *  proof/ on every projection with `{withFileTypes: true}`: pre-existing
   *  IO that exists at base too, orthogonal to the acceptance union FS-1
   *  bounds (observation routed to pm — same per-mission fan-out family). */
  function proofReaddirCount(): number {
    const mocked = fs.readdirSync as unknown as { mock: { calls: unknown[][] } };
    return mocked.mock.calls.filter(
      (args) => String(args[0]).endsWith(join(SLICE, "proof")) && args[1] === undefined,
    ).length;
  }

  function clearReaddirRecord(): void {
    (fs.readdirSync as unknown as { mockClear: () => void }).mockClear();
  }

  it("FS-1a: a no-contract slice performs ZERO readdirs of proof/", () => {
    rmSync(fileOf("IMPLEMENTATION-PRD.md"));
    indexer.get(SLICE); // index before clearing — only project() is under test
    clearReaddirRecord();
    acceptanceOf();
    expect(proofReaddirCount()).toBe(0);
  });

  it("FS-1b: an all-ticked contract performs ZERO readdirs of proof/ (union can only lift)", () => {
    editFile("README.md", (c) => {
      const contractStart = c.indexOf("## Proof contract");
      const head = c.slice(0, contractStart);
      const tail = c.slice(contractStart).replace(/- \[ \] \*\*/g, "- [x] **");
      return head + tail;
    });
    indexer.get(SLICE);
    clearReaddirRecord();
    const a = acceptanceOf();
    expect(a.doneItems).toBe(13);
    expect(proofReaddirCount()).toBe(0);
  });

  it("FS-1c: an unticked authored contract reads proof/ exactly once per projection", () => {
    indexer.get(SLICE);
    clearReaddirRecord();
    acceptanceOf();
    expect(proofReaddirCount()).toBe(1);
  });
});
