// OPR.0.5.3.5 RECAP atom (mini-req 7 / Q2 + Q2-Amendment 1) — the seat recap
// store: the AUTHORED recap (decisions-with-rationale, written by the outgoing
// occupant at the boundary) extending the shipped from-record boot recap's
// name per the Q2 unify-what-exists ruling. Seat-homed beside LEARNED;
// SUPERSEDED-CHAIN retention under the seat directory (newest is current,
// predecessors kept, cleaned by seat-directory lifecycle, never a librarian);
// the authoring contract validated ADVISORY on its CHECKABLE subset — findings
// flag for review, never gate a handover (the D2 pattern: prose shape must not
// block a boundary).

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeSeatRecap, listRecapChain, validateRecapContract } from "../src/domain/context-packs/seat-recap-store.js";

const GOOD_RECAP = [
  "## Recent Decisions",
  "We chose X because Y outweighed Z at the time.",
  "UNVERIFIED: the Z cost figure came second-hand from the ops channel.",
  "## Open Threads",
  "Derive the live count with `rig queue list --mine` rather than trusting this snapshot.",
].join("\n");

let seatDir: string;
beforeEach(() => { seatDir = mkdtempSync(join(tmpdir(), "s05-recap-")); });
afterEach(() => rmSync(seatDir, { recursive: true, force: true }));

describe("writeSeatRecap — superseded-chain retention (Q2-Amendment 1(b))", () => {
  it("first write creates RECAP.md; a second write supersedes the first INTO the chain, byte-preserved", () => {
    let t = 1000;
    writeSeatRecap({ seatDir, content: "## Recent Decisions\nfirst era", now: () => t });
    t = 2000;
    writeSeatRecap({ seatDir, content: GOOD_RECAP, now: () => t });
    expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toBe(GOOD_RECAP);
    const chain = listRecapChain(seatDir);
    expect(chain).toHaveLength(1);
    expect(readFileSync(chain[0]!.path, "utf-8")).toBe("## Recent Decisions\nfirst era");
    // The chain lives UNDER the seat directory (seat-directory lifecycle owns
    // cleanup) and its names sort by supersession time.
    expect(chain[0]!.path.startsWith(seatDir)).toBe(true);
  });

  it("three eras: the chain lists oldest-first and the current file is always the newest", () => {
    let t = 1;
    for (const era of ["one", "two", "three"]) {
      writeSeatRecap({ seatDir, content: `## Recent Decisions\n${era}`, now: () => t++ });
    }
    expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("three");
    const chain = listRecapChain(seatDir);
    expect(chain.map((c) => readFileSync(c.path, "utf-8"))).toEqual([
      "## Recent Decisions\none",
      "## Recent Decisions\ntwo",
    ]);
  });

  it("r1 F1: SAME-MILLISECOND supersessions lose NOTHING — every predecessor stays byte-preserved", () => {
    // r1's constructed break: renameSync onto an existing path REPLACES it, so
    // two supersessions in one millisecond overwrote the first chain entry —
    // the retention contract (byte-preserved, cleaned only by lifecycle)
    // inverted, silently. now is INJECTABLE, so programmatic callers collide
    // deterministically, not rarely.
    let t = 5000;
    writeSeatRecap({ seatDir, content: "## Decisions\nv1", now: () => t });
    t = 7777;
    writeSeatRecap({ seatDir, content: "## Decisions\nv2", now: () => t });
    writeSeatRecap({ seatDir, content: "## Decisions\nv3", now: () => t }); // same ms
    const chain = listRecapChain(seatDir);
    expect(chain).toHaveLength(2);
    const bodies = chain.map((c) => readFileSync(c.path, "utf-8"));
    expect(bodies).toContain("## Decisions\nv1");
    expect(bodies).toContain("## Decisions\nv2");
    expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toBe("## Decisions\nv3");
  });

  it("r1 bonus property (pinned at their ask): a write that FAILS the gate leaves the current recap AND the chain untouched", () => {
    writeSeatRecap({ seatDir, content: "## Decisions\nstanding era", now: () => 1 });
    expect(() => writeSeatRecap({ seatDir, content: "## Same\na\n## Same\nb", now: () => 2 })).toThrow();
    expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toBe("## Decisions\nstanding era");
    expect(listRecapChain(seatDir)).toHaveLength(0);
  });

  it("the current recap stays addressable: an unaddressable write is REJECTED loud (it could never compose)", () => {
    // The recap is composed BY ADDRESS (seat:RECAP.md#...) — a recap that
    // cannot resolve would fail every handover profile downstream, silently
    // late. This is the one non-advisory gate, and it is structural, not
    // prose-shaped: duplicate header paths / unterminated fences.
    expect(() => writeSeatRecap({ seatDir, content: "## Same\na\n## Same\nb", now: () => 1 }))
      .toThrow(/duplicate|addressab/i);
  });
});

describe("validateRecapContract — the CHECKABLE subset, advisory findings (Q2 authoring contract)", () => {
  it("a contract-shaped recap yields no findings", () => {
    expect(validateRecapContract(GOOD_RECAP)).toEqual([]);
  });

  it("flags a missing decisions section — conclusions without decisions is the lossy handoff shape", () => {
    const findings = validateRecapContract("## Status\nall done, trust me");
    expect(findings.some((f) => f.kind === "no-decisions-section")).toBe(true);
  });

  it("flags a lowercase/variant unverified marker — one bad fact poisons every future turn, the marker must be findable", () => {
    const findings = validateRecapContract("## Recent Decisions\nchose X because Y.\n(unverified: the Y figure)");
    expect(findings.some((f) => f.kind === "nonstandard-unverified-marker")).toBe(true);
  });

  it("findings NEVER throw — the contract advises, the boundary is not blocked on prose shape", () => {
    expect(() => validateRecapContract("free prose, no headers at all")).not.toThrow();
  });
});
