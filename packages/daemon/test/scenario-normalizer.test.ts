import { describe, it, expect } from "vitest";
import {
  projectSurface,
  buildDeclarativeNormalizer,
  isEqualsMapping,
  rigOf,
} from "./helpers/scenario-normalizer.js";

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

  it("is total on shapes it did not expect (no throw, no fabricated value)", () => {
    expect(projectSurface([], { pluck: "name" })).toEqual([]);
    expect(projectSurface(null, { pluck: "name" })).toEqual([]);
    expect(projectSurface([{ other: 1 }], { pluck: "name" })).toEqual([]);
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
