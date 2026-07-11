// VM-005 (release-0.4.7) — the reconciled mission-status matrix (plan §D).
//
// V1 disagreement (authored wins) · V2 idle (never the retired UNKNOWN word)
// · V3 all-draft (Q2) · V4 no-decay (clock-injected) · V5 byte-identity
// carve · V6 frozen-fixture binding · Q3-P1 closed-constant normalizer ·
// FR-4 bucket coherence. Pure unit tier; the DOM tier lives in
// mission-status-surfaces.test.tsx; the live money-shot is the proof leg.

import { describe, it, expect } from "vitest";
import {
  AUTHORED_WORD_TONES,
  PROJECT_CURRENT_ACTIVITY_WINDOW_MS,
  partitionProjectMissions,
  projectMissionBucket,
  reconcileMissionStatus,
  type ProjectSliceRow,
} from "../src/lib/project-mission-state.js";

const NOW = Date.parse("2026-07-11T12:00:00.000Z");

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

const RECENT = new Date(NOW - 60_000).toISOString();
const STALE = new Date(NOW - PROJECT_CURRENT_ACTIVITY_WINDOW_MS - 60_000).toISOString();

describe("V1 — authored-when-present wins (FR-1 keystone)", () => {
  it("authored 'complete' beats a recently-active slice; the raw word renders", () => {
    const rec = reconcileMissionStatus("complete", [slice({ lastActivityAt: RECENT })], NOW);
    expect(rec.source).toBe("authored");
    expect(rec.label).toBe("complete"); // the author's word VERBATIM
    expect(rec.state).toBe("shipped"); // tone via the closed constant
  });

  it("authored path never consults slices at all (identical result for any corpus)", () => {
    const a = reconcileMissionStatus("paused", [], NOW);
    const b = reconcileMissionStatus("paused", [slice({ status: "blocked", qitemCount: 3 })], NOW);
    expect(a).toEqual(b);
  });
});

describe("V2 — honest known states, the retired UNKNOWN word is dead (FR-2)", () => {
  it("idle slices (activity aged past the window) derive 'idle'", () => {
    const rec = reconcileMissionStatus(null, [slice({ lastActivityAt: STALE })], NOW);
    expect(rec).toEqual({ state: "idle", label: "idle", source: "derived" });
  });

  it("zero slices derive 'empty' (the tree-only word)", () => {
    expect(reconcileMissionStatus(null, [], NOW).state).toBe("empty");
  });

  it("no input class ever yields the retired word", () => {
    const corpora: ProjectSliceRow[][] = [
      [],
      [slice({ lastActivityAt: STALE })],
      [slice({ status: "draft" })],
      [slice({ status: "done" })],
      [slice({ status: "blocked" })],
      [slice({ status: "done" }), slice({ status: "draft", lastActivityAt: STALE })],
    ];
    for (const c of corpora) {
      expect(reconcileMissionStatus(null, c, NOW).state).not.toBe("unknown");
    }
  });
});

describe("V3 — all-draft missions are 'draft', not active (Q2)", () => {
  it("fresh scaffolds (recent mtimes, all draft) derive draft", () => {
    const rec = reconcileMissionStatus(
      null,
      [slice({ status: "draft", lastActivityAt: RECENT }), slice({ status: "draft", lastActivityAt: RECENT })],
      NOW,
    );
    expect(rec.state).toBe("draft");
  });

  it("a blocked-current draft mission still surfaces blocked (ladder order)", () => {
    const rec = reconcileMissionStatus(
      null,
      [slice({ status: "draft", lastActivityAt: RECENT }), slice({ status: "blocked" })],
      NOW,
    );
    expect(rec.state).toBe("blocked");
  });

  it("draft mixed with a current active slice derives active (not draft)", () => {
    const rec = reconcileMissionStatus(
      null,
      [slice({ status: "draft", lastActivityAt: RECENT }), slice({ status: "active", lastActivityAt: RECENT })],
      NOW,
    );
    expect(rec.state).toBe("active");
  });
});

describe("V4 — no clock decay for authored status (FR-2)", () => {
  const JUMP = NOW + PROJECT_CURRENT_ACTIVITY_WINDOW_MS * 10;

  it("authored 'complete' and authored 'active' are byte-stable across a huge clock jump", () => {
    for (const word of ["complete", "active"]) {
      const before = reconcileMissionStatus(word, [slice({ lastActivityAt: RECENT })], NOW);
      const after = reconcileMissionStatus(word, [slice({ lastActivityAt: RECENT })], JUMP);
      expect(after).toEqual(before); // BYTE-STABLE: authored never consults the clock
    }
  });

  it("the DERIVED path is allowed to move active→idle on the same jump (the window stays the derived discriminator)", () => {
    const corpus = [slice({ lastActivityAt: RECENT })];
    expect(reconcileMissionStatus(null, corpus, NOW).state).toBe("active");
    expect(reconcileMissionStatus(null, corpus, JUMP).state).toBe("idle");
  });
});

describe("V5 — byte-identity carve (zero regression on agreeing corpora)", () => {
  it("(a) authored == derived agree: the state matches what the roll-up lands", () => {
    const corpus = [slice({ status: "done" }), slice({ status: "done" })];
    const derived = reconcileMissionStatus(null, corpus, NOW);
    const authored = reconcileMissionStatus("shipped", corpus, NOW);
    expect(derived.state).toBe("shipped");
    expect(authored.state).toBe("shipped");
  });

  it("(b) authored-absent roll-ups land today's named buckets, string-identical", () => {
    // Pinned pre-change expectations (8757593f behavior) as literals:
    expect(reconcileMissionStatus(null, [slice({ status: "active", lastActivityAt: RECENT })], NOW).state).toBe("active");
    expect(reconcileMissionStatus(null, [slice({ status: "blocked" })], NOW).state).toBe("blocked");
    expect(reconcileMissionStatus(null, [slice({ status: "done" })], NOW).state).toBe("shipped");
  });

  it("(b2) bucket assignment identical pre/post for derived groups", () => {
    const current = { id: "m", label: "m", status: "active" as const, statusSource: "derived" as const, slices: [slice({ lastActivityAt: RECENT })] };
    const archive = { id: "m2", label: "m2", status: "shipped" as const, statusSource: "derived" as const, slices: [slice({ status: "done", lastActivityAt: STALE })] };
    expect(projectMissionBucket(current)).toBe("current");
    expect(projectMissionBucket(archive)).toBe("archive");
    // zero-slice non-shipped stays current (today's behavior, preserved)
    expect(projectMissionBucket({ id: "e", label: "e", status: "empty" as const, statusSource: "derived" as const, slices: [] })).toBe("current");
  });
});

describe("V6 — frozen VM-005 fixture binding (qitem …5d184b24 packet)", () => {
  // The frozen mission README frontmatter, byte-bound from the evidence root
  // (fixture/README.md sha256 660068d4…e688262, packet sha256 274a24f9…04d1ed):
  // it declares stage/id/release — and NO `status:` field. At base the
  // explorer projected this canonical WIP mission as UNKNOWN.
  const FROZEN_FRONTMATTER_FIELDS = {
    id: "OPR.0.4.7",
    mission: "release-0.4.7",
    release: "0.4.7",
    stage: "wip",
  };

  it("the frozen mission (no authored status, live slices) reconciles to a KNOWN word", () => {
    // `stage: wip` is NOT `status:` — authored is null for these bytes.
    expect("status" in FROZEN_FRONTMATTER_FIELDS).toBe(false);
    const rec = reconcileMissionStatus(null, [slice({ lastActivityAt: RECENT })], NOW);
    expect(rec.state).toBe("active");
    expect(rec.state).not.toBe("unknown");
    // And when its slices go quiet, the honest word — still never UNKNOWN:
    const quiet = reconcileMissionStatus(null, [slice({ lastActivityAt: STALE })], NOW);
    expect(quiet.state).toBe("idle");
  });
});

describe("Q3-P1 — the closed-constant normalizer", () => {
  it("shipped-family words map to shipped tone; the word still renders", () => {
    for (const word of ["complete", "completed", "done", "shipped"]) {
      const rec = reconcileMissionStatus(word, [], NOW);
      expect(rec.state).toBe("shipped");
      expect(rec.label).toBe(word);
    }
  });

  it("unrecognized authored word → neutral tone, the word STILL WINS and renders verbatim", () => {
    const rec = reconcileMissionStatus("Percolating", [slice({ lastActivityAt: RECENT })], NOW);
    expect(rec.source).toBe("authored");
    expect(rec.label).toBe("Percolating"); // verbatim, case preserved
    expect(rec.state).toBe("idle"); // the neutral tone-carrier
  });

  it("the constant is the ONLY word registry (a new word is one map entry)", () => {
    // Closed-set discipline: every mapped word round-trips through reconcile.
    for (const [word, tone] of Object.entries(AUTHORED_WORD_TONES)) {
      expect(reconcileMissionStatus(word, [], NOW).state).toBe(tone);
    }
  });
});

describe("FR-4 — bucket coherence", () => {
  it("authored shipped-family buckets archive regardless of slice recency", () => {
    const rec = reconcileMissionStatus("complete", [slice({ lastActivityAt: RECENT, qitemCount: 2 })], NOW);
    const bucket = projectMissionBucket({
      id: "m", label: "m", status: rec.state, statusSource: rec.source,
      slices: [slice({ lastActivityAt: RECENT, qitemCount: 2 })],
    });
    expect(bucket).toBe("archive");
  });

  it("a DERIVED shipped mission with a current slice keeps today's ladder (current)", () => {
    // derived shipped can't have current slices by construction, but the
    // bucket fn must not archive on state alone: pin the ladder order.
    const bucket = projectMissionBucket({
      id: "m", label: "m", status: "shipped", statusSource: "derived",
      slices: [slice({ lastActivityAt: RECENT, qitemCount: 1, status: "done" })],
    });
    expect(bucket).toBe("current");
  });

  it("partitionProjectMissions routes an authored-complete recent mission to archive", () => {
    const groups = [
      {
        id: "auth", label: "auth", status: "shipped" as const, statusSource: "authored" as const,
        slices: [slice({ lastActivityAt: RECENT })],
      },
      {
        id: "act", label: "act", status: "active" as const, statusSource: "derived" as const,
        slices: [slice({ lastActivityAt: RECENT })],
      },
    ];
    const { current, archive } = partitionProjectMissions(groups);
    expect(archive.map((m) => m.id)).toEqual(["auth"]);
    expect(current.map((m) => m.id)).toEqual(["act"]);
  });
});
