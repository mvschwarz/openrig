// Build B — make spec-vs-live topology drift VISIBLE. RED-first.
//
// WHY THIS EXISTS: nothing writes a rig spec back after a runtime mutation. `rig expand` adds a pod
// to a RUNNING rig via the daemon and the rigRoot spec is never touched, so drift is not an accident
// — it is the guaranteed outcome of the shipped verbs. The spec is still read as authoritative by
// everything that RECREATES the rig, and `bundle-assembler` copies it VERBATIM into a bundle without
// ever consulting the live DB. On this host that means a bundle export produces an 8-seat rig while
// 14 seats are running, silently, because the spec is internally consistent and validates clean.
//
// This module does not fix the drift. It makes the drift SAYABLE at the two moments it does damage.
//
// THE INVARIANT THAT MATTERS MOST: `message` is non-null EXACTLY when `conforms` is false. A check
// that cannot stay silent is as useless as one that cannot fire — a warning on every export trains
// the reader to skim, and then the one real case reads like the ninety-six before it.

import { describe, it, expect } from "vitest";
import {
  compareSpecToLive,
  topologyFromRigSpec,
  topologyFromLiveLogicalIds,
  type Topology,
} from "../src/domain/spec-live-conformance.js";

/** The shape this host is actually in: spec says orch/dev/review, live also runs dev50/review50. */
const SPEC_3_8: Topology = {
  pods: ["orch", "dev", "review"],
  seats: ["orch.lead", "orch.advisor", "dev.planner", "dev.guard", "dev.driver", "dev.qa", "review.r1", "review.r2"],
};
const LIVE_5_14: Topology = {
  pods: ["orch", "dev", "review", "dev50", "review50"],
  seats: [
    ...SPEC_3_8.seats,
    "dev50.planner", "dev50.guard", "dev50.driver", "dev50.qa",
    "review50.r1", "review50.r2",
  ],
};

describe("spec-vs-live conformance", () => {
  it("NEGATIVE CONTROL — a rig with no drift conforms and says NOTHING", () => {
    const r = compareSpecToLive(SPEC_3_8, { ...SPEC_3_8 });
    expect(r.conforms).toBe(true);
    expect(r.message).toBeNull();
    expect(r.podsMissingFromSpec).toEqual([]);
    expect(r.seatsMissingFromSpec).toEqual([]);
  });

  it("order and duplicates do not manufacture drift", () => {
    const shuffled: Topology = {
      pods: ["review", "orch", "dev", "orch"],
      seats: [...SPEC_3_8.seats].reverse().concat("dev.qa"),
    };
    expect(compareSpecToLive(SPEC_3_8, shuffled).conforms).toBe(true);
  });

  it("this host's real drift — names the pods absent from the spec, with both counts", () => {
    const r = compareSpecToLive(SPEC_3_8, LIVE_5_14);
    expect(r.conforms).toBe(false);
    expect(r.spec).toEqual({ pods: 3, seats: 8 });
    expect(r.live).toEqual({ pods: 5, seats: 14 });
    expect(r.podsMissingFromSpec).toEqual(["dev50", "review50"]);
    expect(r.seatsMissingFromSpec).toHaveLength(6);
    expect(r.podsMissingFromLive).toEqual([]);
  });

  it("the message names the ACTUAL delta, not a generic caution", () => {
    const m = compareSpecToLive(SPEC_3_8, LIVE_5_14).message!;
    // A reader must be able to act on this line alone.
    expect(m).toContain("3 pods");
    expect(m).toContain("8 seats");
    expect(m).toContain("5");
    expect(m).toContain("14");
    expect(m).toContain("dev50");
    expect(m).toContain("review50");
  });

  it("drift in the other direction — a pod in the spec that is not running", () => {
    const live: Topology = {
      pods: ["orch", "dev"],
      seats: SPEC_3_8.seats.filter((s) => !s.startsWith("review.")),
    };
    const r = compareSpecToLive(SPEC_3_8, live);
    expect(r.conforms).toBe(false);
    expect(r.podsMissingFromLive).toEqual(["review"]);
    expect(r.podsMissingFromSpec).toEqual([]);
    expect(r.message).toContain("review");
  });

  it("seat-level drift inside a pod both sides declare", () => {
    const live: Topology = { pods: SPEC_3_8.pods, seats: [...SPEC_3_8.seats, "dev.second-driver"] };
    const r = compareSpecToLive(SPEC_3_8, live);
    expect(r.conforms).toBe(false);
    expect(r.podsMissingFromSpec).toEqual([]);
    expect(r.seatsMissingFromSpec).toEqual(["dev.second-driver"]);
  });

  it("message is non-null EXACTLY when conforms is false", () => {
    const cases: Array<[Topology, Topology]> = [
      [SPEC_3_8, SPEC_3_8],
      [SPEC_3_8, LIVE_5_14],
      [{ pods: [], seats: [] }, { pods: [], seats: [] }],
      [{ pods: [], seats: [] }, SPEC_3_8],
    ];
    for (const [spec, live] of cases) {
      const r = compareSpecToLive(spec, live);
      expect(r.message === null).toBe(r.conforms);
    }
  });

  it("an EMPTY live topology is not reported as conforming drift-free silence", () => {
    // A daemon that returned no nodes must not read as "the spec matches". Silence from the live
    // side is absence of evidence, and the check has to say so rather than pass.
    const r = compareSpecToLive(SPEC_3_8, { pods: [], seats: [] });
    expect(r.conforms).toBe(false);
    // Sorted, not declaration order — the same normalisation that stops ordering manufacturing drift.
    expect(r.podsMissingFromLive).toEqual(["dev", "orch", "review"]);
  });
});

describe("topology extraction", () => {
  it("reads pods and seats off a parsed RigSpec", () => {
    const spec = {
      pods: [
        { id: "orch", members: [{ id: "lead" }, { id: "advisor" }] },
        { id: "dev", members: [{ id: "driver" }] },
      ],
    };
    expect(topologyFromRigSpec(spec as never)).toEqual({
      pods: ["orch", "dev"],
      seats: ["orch.lead", "orch.advisor", "dev.driver"],
    });
  });

  it("derives live topology from node logicalIds, ignoring malformed ids", () => {
    const t = topologyFromLiveLogicalIds([
      "orch.lead", "orch.advisor", "dev50.driver", "", null as never, "no-dot",
    ]);
    expect(t.pods).toEqual(["orch", "dev50"]);
    expect(t.seats).toEqual(["orch.lead", "orch.advisor", "dev50.driver"]);
  });
});
