// VM-005 (release-0.4.7) — TIER B: the new-symbol unit suite + TIER A pure
// bucket differential (plan v1.3 §D-bis; ARCH-RULING-b3, sha 632ff319…).
//
// Tier B (below): DYNAMIC import of project-mission-state.js (the module
// exists at both SHAs, so the import always succeeds); the t1 PRESENCE
// assertion is UNCONDITIONAL and FIRST — at base 8757593f it is the counted,
// named RED ("expected 'undefined' to be 'function'"); the unit cases run
// conditionally and the t3 executed-count assertion pins that ALL of them
// ran at the candidate.
//
// Tier A (bottom): the FR-4 bucket differential + V5 pure carve through
// both-ends STATIC imports (projectMissionBucket / partitionProjectMissions
// exist at both SHAs) — candidate expectations verbatim, one code path.

import { describe, it, expect, beforeAll } from "vitest";
import {
  projectMissionBucket,
  partitionProjectMissions,
  PROJECT_CURRENT_ACTIVITY_WINDOW_MS,
  type ProjectSliceRow,
} from "../src/lib/project-mission-state.js";

const NOW = Date.parse("2026-07-11T12:00:00.000Z");
const RECENT = new Date(NOW - 60_000).toISOString();
const STALE = new Date(NOW - PROJECT_CURRENT_ACTIVITY_WINDOW_MS - 60_000).toISOString();

function slice(over: Partial<ProjectSliceRow>): ProjectSliceRow {
  return {
    name: "s1",
    displayName: "S1",
    status: "active",
    rawStatus: null,
    qitemCount: 0,
    hasProofPacket: false,
    lastActivityAt: null,
    missionId: "m1",
    railItem: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// TIER B — new-symbol units (t1/t2/t3 per the B3 ruling)
// ---------------------------------------------------------------------------

type Pms = typeof import("../src/lib/project-mission-state.js");
let pms: Pms;
const executed: string[] = [];
const TIER_B_CASES = [
  "label-verbatim",
  "corpus-independence",
  "injected-now-purity",
  "closed-map-roundtrip",
  "unrecognized-neutral",
  "derived-ladder-words",
  "v6-frozen-semantics",
] as const;

beforeAll(async () => {
  pms = await import("../src/lib/project-mission-state.js");
});

describe("Tier B — reconcileMissionStatus unit contract (t1 presence FIRST)", () => {
  // t1 — UNCONDITIONAL, FIRST: the counted named RED at base.
  it("t1: the reconciled home exists (reconcileMissionStatus + AUTHORED_WORD_TONES exported)", () => {
    expect(typeof (pms as Record<string, unknown>).reconcileMissionStatus).toBe("function");
    expect(typeof (pms as Record<string, unknown>).AUTHORED_WORD_TONES).toBe("object");
  });

  // t2 (B3 ruling, arch sha 632ff319…): the cases below run conditionally at
  // base ONLY because the symbols do not exist there; NO DIFFERENTIAL VECTOR
  // may ever move inside this conditional block — differentials live in the
  // Tier A suites (mission-status-surfaces.test.tsx + the Tier A block below).
  const hasHome = () =>
    typeof (pms as Record<string, unknown>).reconcileMissionStatus === "function";

  it("authored label renders VERBATIM (case preserved), tone via the closed constant", () => {
    if (!hasHome()) return;
    executed.push("label-verbatim");
    const rec = pms.reconcileMissionStatus("complete", [slice({ lastActivityAt: RECENT })], NOW);
    expect(rec).toEqual({ state: "shipped", label: "complete", source: "authored" });
    expect(pms.reconcileMissionStatus("Complete", [], NOW).label).toBe("Complete");
  });

  it("authored path never consults slices (identical result for any corpus)", () => {
    if (!hasHome()) return;
    executed.push("corpus-independence");
    const a = pms.reconcileMissionStatus("paused", [], NOW);
    const b = pms.reconcileMissionStatus("paused", [slice({ status: "blocked", qitemCount: 3 })], NOW);
    expect(a).toEqual(b);
  });

  it("clock purity: `now` is injected — authored output byte-stable across any jump", () => {
    if (!hasHome()) return;
    executed.push("injected-now-purity");
    const JUMP = NOW + PROJECT_CURRENT_ACTIVITY_WINDOW_MS * 10;
    for (const word of ["complete", "active"]) {
      const before = pms.reconcileMissionStatus(word, [slice({ lastActivityAt: RECENT })], NOW);
      const after = pms.reconcileMissionStatus(word, [slice({ lastActivityAt: RECENT })], JUMP);
      expect(after).toEqual(before);
    }
    // derived keeps the window as its discriminator (unit mirror of the DOM V4)
    const corpus = [slice({ lastActivityAt: RECENT })];
    expect(pms.reconcileMissionStatus(null, corpus, NOW).state).toBe("active");
    expect(pms.reconcileMissionStatus(null, corpus, JUMP).state).toBe("idle");
  });

  it("Q3-P1: the closed map is the ONLY word registry; every entry round-trips", () => {
    if (!hasHome()) return;
    executed.push("closed-map-roundtrip");
    for (const [word, tone] of Object.entries(pms.AUTHORED_WORD_TONES)) {
      expect(pms.reconcileMissionStatus(word, [], NOW).state).toBe(tone);
    }
    for (const word of ["complete", "completed", "done", "shipped"]) {
      expect(pms.AUTHORED_WORD_TONES[word]).toBe("shipped");
    }
  });

  it("unrecognized authored word → neutral tone (idle carrier), the word still wins verbatim", () => {
    if (!hasHome()) return;
    executed.push("unrecognized-neutral");
    const rec = pms.reconcileMissionStatus("Percolating", [slice({ lastActivityAt: RECENT })], NOW);
    expect(rec).toEqual({ state: "idle", label: "Percolating", source: "authored" });
  });

  it("derived ladder words: empty · blocked · draft · active · shipped · idle (the retired word is unreachable)", () => {
    if (!hasHome()) return;
    executed.push("derived-ladder-words");
    expect(pms.reconcileMissionStatus(null, [], NOW).state).toBe("empty");
    expect(pms.reconcileMissionStatus(null, [slice({ status: "blocked" })], NOW).state).toBe("blocked");
    expect(
      pms.reconcileMissionStatus(null, [slice({ status: "draft", lastActivityAt: RECENT })], NOW).state,
    ).toBe("draft");
    expect(pms.reconcileMissionStatus(null, [slice({ lastActivityAt: RECENT })], NOW).state).toBe("active");
    expect(pms.reconcileMissionStatus(null, [slice({ status: "done" })], NOW).state).toBe("shipped");
    expect(pms.reconcileMissionStatus(null, [slice({ lastActivityAt: STALE })], NOW).state).toBe("idle");
    const corpora: ProjectSliceRow[][] = [
      [],
      [slice({ lastActivityAt: STALE })],
      [slice({ status: "done" }), slice({ status: "draft", lastActivityAt: STALE })],
    ];
    for (const c of corpora) {
      expect(pms.reconcileMissionStatus(null, c, NOW).state).not.toBe("unknown");
    }
  });

  it("V6 frozen-fixture semantics (packet …5d184b24): no authored status → honest derived word", () => {
    if (!hasHome()) return;
    executed.push("v6-frozen-semantics");
    // The frozen mission README (fixture/README.md sha 660068d4…) carries
    // stage/id/release and NO `status:` — authored is null for those bytes
    // (the daemon-side lockstep test binds the actual bytes).
    expect(pms.reconcileMissionStatus(null, [slice({ lastActivityAt: RECENT })], NOW).state).toBe("active");
    expect(pms.reconcileMissionStatus(null, [slice({ lastActivityAt: STALE })], NOW).state).toBe("idle");
  });

  // t3 — at the candidate, ALL Tier-B cases must have executed (silent-skip fence).
  it("t3: all Tier-B cases executed at the candidate", () => {
    if (!hasHome()) return;
    expect(executed.sort()).toEqual([...TIER_B_CASES].sort());
  });
});

// ---------------------------------------------------------------------------
// TIER A — FR-4 bucket differential + V5 pure carve (both-ends static imports,
// one code path, candidate expectations verbatim)
// ---------------------------------------------------------------------------

describe("Tier A — FR-4 bucket coherence (differential: named RED at base)", () => {
  it("an AUTHORED shipped mission buckets ARCHIVE regardless of slice recency", () => {
    const bucket = projectMissionBucket({
      id: "m",
      label: "m",
      status: "shipped",
      statusSource: "authored",
      slices: [slice({ lastActivityAt: RECENT, qitemCount: 2 })],
    } as Parameters<typeof projectMissionBucket>[0]);
    expect(bucket).toBe("archive");
  });

  it("partitionProjectMissions routes the authored-complete recent mission to archive", () => {
    const groups = [
      {
        id: "auth", label: "auth", status: "shipped", statusSource: "authored",
        slices: [slice({ lastActivityAt: RECENT })],
      },
      {
        id: "act", label: "act", status: "active", statusSource: "derived",
        slices: [slice({ lastActivityAt: RECENT })],
      },
    ] as Parameters<typeof partitionProjectMissions>[0];
    // Inject the fixture clock (NOW) so the fixed-timestamp RECENT slice is evaluated against the
    // instant it was authored for — NOT wall-clock. Without this the differential rotted to RED as
    // real time advanced 27 days past the 36h window (the excluded ui leg hid it until F1's gap-1).
    const { current, archive } = partitionProjectMissions(groups, NOW);
    expect(archive.map((m) => m.id)).toEqual(["auth"]);
    expect(current.map((m) => m.id)).toEqual(["act"]);
  });
});

// VM-005 time-bomb CLASS-KILL: recency bucketing must follow the INJECTED clock, never wall-clock.
// A fixed-timestamp fixture that reaches un-injected production time rots to the wrong bucket as real
// time advances — exactly the failure F1's closed gap-1 surfaced. This pin proves the seam is honored,
// so any fixed-clock differential can (and must) inject `now` and stay deterministic forever.
describe("Tier A — clock-determinism guard (time-bomb class-kill)", () => {
  it("projectMissionBucket + partitionProjectMissions bucket by the injected now, not Date.now()", () => {
    const fixed = "2020-01-01T00:00:00.000Z"; // long-dead wall-clock: under real Date.now() ALWAYS archive
    const at = Date.parse(fixed);
    const m = {
      id: "m", label: "m", status: "active", statusSource: "derived",
      slices: [slice({ lastActivityAt: fixed })],
    } as Parameters<typeof projectMissionBucket>[0];
    // Within-window of the INJECTED now → current (would be archive if the fn read Date.now()).
    expect(projectMissionBucket(m, at + 60_000)).toBe("current");
    // Past the window of the injected now → archive — deterministic regardless of real time.
    expect(projectMissionBucket(m, at + PROJECT_CURRENT_ACTIVITY_WINDOW_MS + 60_000)).toBe("archive");
    // partitionProjectMissions threads the same clock end-to-end.
    expect(partitionProjectMissions([m], at + 60_000).current.map((x) => x.id)).toEqual(["m"]);
    expect(partitionProjectMissions([m], at + PROJECT_CURRENT_ACTIVITY_WINDOW_MS + 60_000).archive.map((x) => x.id)).toEqual(["m"]);
  });
});

describe("Tier A — V5 bucket byte-identity (green at BOTH SHAs)", () => {
  it("derived groups keep today's ladder byte-for-byte", () => {
    const current = {
      id: "m", label: "m", status: "active", statusSource: "derived",
      slices: [slice({ lastActivityAt: new Date(Date.now() - 60_000).toISOString() })],
    } as Parameters<typeof projectMissionBucket>[0];
    const archived = {
      id: "m2", label: "m2", status: "shipped", statusSource: "derived",
      slices: [slice({ status: "done", lastActivityAt: STALE })],
    } as Parameters<typeof projectMissionBucket>[0];
    const empty = {
      id: "e", label: "e", status: "active", statusSource: "derived", slices: [],
    } as Parameters<typeof projectMissionBucket>[0];
    expect(projectMissionBucket(current)).toBe("current");
    expect(projectMissionBucket(archived)).toBe("archive");
    expect(projectMissionBucket(empty)).toBe("current"); // zero-slice non-shipped stays current
  });
});
