import { describe, it, expect } from "vitest";
import {
  projectSurface,
  buildDeclarativeNormalizer,
  isEqualsMapping,
  rigOf,
  ProjectionError,
} from "./helpers/scenario-normalizer.js";
import { validateScenario } from "./helpers/scenario-schema.js";

// 51-03 — the declarative cross-surface mapping. A-N1: this is the only
// scenario-facing form and it LOWERS to the runner-internal seam.

describe("projectSurface — declares which field carries the shared truth", () => {
  it("plucks a field from an array surface, deduped and sorted (set semantics)", () => {
    const ps = [{ name: "b-rig" }, { name: "a-rig" }, { name: "a-rig" }];
    expect(projectSurface(ps, { pluck: "name" })).toEqual(["a-rig", "b-rig"]);
  });

  it("reduces canonical session names to their rig — N qitems on one rig collapse to one", () => {
    const queue = [
      { destinationSession: "dev-worker@scn-baton" },
      { destinationSession: "dev-qa@scn-baton" },
    ];
    expect(projectSurface(queue, { pluck: "destinationSession", rig: true })).toEqual(["scn-baton"]);
  });

  it("returns empty for genuinely empty input, but THROWS when real data yields nothing", () => {
    expect(projectSurface([], { pluck: "name" })).toEqual([]);
    expect(projectSurface(null, { pluck: "name" })).toEqual([]);
    // non-empty input + zero extracted = broken declaration, not agreement
    expect(() => projectSurface([{ other: 1 }], { pluck: "name" })).toThrow(ProjectionError);
  });

  it("reads a nested path on an object surface before projecting", () => {
    expect(projectSurface({ state: { screen: "topology" } }, { path: "state.screen" })).toBe("topology");
  });

  it("rigOf takes the part after the LAST @ and passes through a bare name", () => {
    expect(rigOf("dev-worker@scn-baton")).toBe("scn-baton");
    expect(rigOf("bare")).toBe("bare");
  });
});

describe("buildDeclarativeNormalizer — lowering onto the seam", () => {
  it("applies each surface's declared projection and passes undeclared surfaces through", () => {
    const n = buildDeclarativeNormalizer({
      ps: { pluck: "name" },
      queue: { pluck: "destinationSession", rig: true },
    });
    expect(n("ps", [{ name: "scn-baton" }])).toEqual(["scn-baton"]);
    expect(n("queue", [{ destinationSession: "dev-worker@scn-baton" }])).toEqual(["scn-baton"]);
    // a surface with no declared projection is NOT silently emptied
    expect(n("stream", [{ id: 1 }])).toEqual([{ id: 1 }]);
  });

  it("distinguishes the declarative mapping from the legacy surface list", () => {
    expect(isEqualsMapping({ ps: { pluck: "name" } })).toBe(true);
    expect(isEqualsMapping(["tui_socket", "ps", "queue"])).toBe(false);
  });

  it("two surfaces that genuinely disagree do NOT normalize equal (the pin has teeth)", () => {
    const n = buildDeclarativeNormalizer({ ps: { pluck: "name" }, queue: { pluck: "destinationSession", rig: true } });
    expect(n("ps", [{ name: "scn-baton" }])).not.toEqual(n("queue", [{ destinationSession: "w@other-rig" }]));
  });
});

// Guard finding on a7b6b7c85, reproduced by the desk: my own falsification broke
// ONE side (name -> rigId) and got a correct FAIL, so I called the comparison
// value-sensitive. It is — on the DIFFERENCE axis. It could not detect EMPTINESS.
// A falsification only covers the axis it perturbs; these cover the others.
describe("the axes my one-sided falsification could not reach", () => {
  it("SYMMETRIC EMPTY: both sides plucking a missing field must FAIL LOUD, never compare equal", () => {
    const n = buildDeclarativeNormalizer({
      ps: { pluck: "nosuchfield" },
      queue: { pluck: "alsomissing" },
    });
    // two DISTINCT non-empty surfaces; before the fix both became [] and passed
    expect(() => n("ps", [{ name: "scn-baton" }])).toThrow(ProjectionError);
    expect(() => n("queue", [{ destinationSession: "w@scn-baton" }])).toThrow(ProjectionError);
    let msg = "";
    try { n("ps", [{ name: "scn-baton" }]); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("extracted NOTHING");
    expect(msg).toContain("nosuchfield");
  });

  it("empty-from-EMPTY stays legal — a surface may honestly hold nothing", () => {
    const n = buildDeclarativeNormalizer({ queue: { pluck: "destinationSession", rig: true } });
    expect(n("queue", [])).toEqual([]);
  });

  it("a partially-matching projection does NOT throw (some data extracted is a real answer)", () => {
    const n = buildDeclarativeNormalizer({ ps: { pluck: "name" } });
    expect(n("ps", [{ name: "a" }, { other: 1 }])).toEqual(["a"]);
  });
});

describe("load-time refusals (a TypeError must never be the first signal)", () => {
  const base = (equals: unknown) => ({
    scenario: "s", topology: "t.yaml",
    steps: [{ expect: { surface: "ps", equals } }],
  });
  const codes = (doc: unknown) => {
    const r = validateScenario(doc);
    return r.ok ? [] : r.errors.map((e) => e.code);
  };

  it("refuses a SINGLE-surface equals — one-sided comparison is vacuous by construction", () => {
    expect(codes(base({ ps: { pluck: "name" } }))).toContain("EQUALS_TOO_FEW_SURFACES");
  });

  it("refuses an EMPTY equals mapping", () => {
    expect(codes(base({}))).toContain("EQUALS_TOO_FEW_SURFACES");
  });

  it("refuses the LEGACY list form, naming the declarative form", () => {
    expect(codes(base(["ps", "queue"]))).toContain("EQUALS_NOT_DECLARATIVE");
  });

  it("refuses a non-string path at LOAD instead of throwing at runtime", () => {
    expect(codes(base({ ps: { path: 123 }, queue: { pluck: "x" } }))).toContain("EQUALS_PROJECTION_INVALID");
  });

  it("accepts a well-formed two-surface declarative mapping", () => {
    const r = validateScenario(base({ ps: { pluck: "name" }, queue: { pluck: "destinationSession", rig: true } }));
    expect(r.ok).toBe(true);
  });
});
