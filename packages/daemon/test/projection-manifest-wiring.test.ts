import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// P20 WIRING PIN (dead-invalidator / uninjected-service class — orch-named, r1's
// P7-pin + P17's own uninjected-resolver precedent). The discrimination is proven
// (conflict-detector-discrimination + projection-planner tests), but it only ACTS
// if rigspec-instantiator ACTUALLY injects the real manifest lookup into
// planProjection in production. RigSpecInstantiator is deep-launch-path (not
// unit-constructable), so this pins the enable path at source — a wiring drop
// (removing the store or the lastHashLookup) fails HERE, before it can ship a
// silent dead invalidator (lookup null forever → P17 fallback).
describe("P20 wiring pin — rigspec-instantiator injects the REAL manifest lookup", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/domain/rigspec-instantiator.ts", import.meta.url)),
    "utf-8",
  );

  it("constructs a ProjectionManifestStore on the real db (this.db), not a mock", () => {
    expect(src).toMatch(/new ProjectionManifestStore\(this\.db\)/);
  });

  it("the planProjection call wires lastHashLookup to that store's lastHash (the enable path)", () => {
    // the planProjection({...}) options object carries a lastHashLookup that calls
    // the store — a drop of this line reverts to P17-fallback-forever (dead invalidator).
    expect(src).toMatch(/lastHashLookup:\s*\(targetPath\)\s*=>\s*projectionManifest\.lastHash\(targetPath\)/);
  });
});

// P20 atom-4 PROTECT wiring pin. filterProtectedProjections is unit-proven
// (projection-protect.test.ts), but it only ACTS if the instantiator actually
// filters the delivered files through it AND threads the operator's force flag.
// A drop of either (stop calling the filter, or hardcode force) silently reverts
// to "overwrite operator edits" while the warning still claims "not overwritten".
describe("P20 atom-4 wiring pin — the instantiator delivers the PROTECT-filtered set with the real force flag", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/domain/rigspec-instantiator.ts", import.meta.url)),
    "utf-8",
  );

  it("filters the delivered projection files through filterProtectedProjections and takes .delivered", () => {
    expect(src).toMatch(/filterProtectedProjections\(/);
    expect(src).toMatch(/\}\s*,?\s*\)\.delivered/);
  });

  it("threads the operator force flag into the filter (not a hardcoded value)", () => {
    // the filter is gated on { force: input.force } — the node input's force, which
    // the pod loop feeds from opts?.force. A hardcoded force:true would defeat protect.
    expect(src).toMatch(/\{\s*force:\s*input\.force\s*\}/);
    expect(src).toMatch(/force:\s*opts\?\.force/);
  });
});

// P20 record-at-apply WRITE-SIDE wiring pin (review-r1 LOW — symmetry with the
// lookup-side pin). recordProjection is proven invoked in the adapter
// (claude-adapter-record-projection.test.ts), but it only records if STARTUP
// actually constructs the store and passes a real record() callback. A drop here
// SAFE-degrades to P17 (never a wrong overwrite), so it's LOW — but silent: the
// manifest would simply never populate and every divergence would stay
// hash_conflict forever. This pins the enable path so a drop is visible, not silent.
describe("P20 record-at-apply wiring pin — startup wires recordProjection to the real store", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/startup.ts", import.meta.url)),
    "utf-8",
  );

  it("constructs a ProjectionManifestStore on the real db", () => {
    expect(src).toMatch(/new ProjectionManifestStore\(db\)/);
  });

  it("passes recordProjection that records the written hash to that store (the enable path)", () => {
    // recordProjection -> projectionManifestStore.record({ ..., lastHash: hashContent(content), ... }).
    // A drop means the manifest never populates (silent degrade to P17-forever).
    expect(src).toMatch(/recordProjection:\s*\([^)]*\)\s*=>\s*projectionManifestStore\.record\(/);
    expect(src).toMatch(/lastHash:\s*hashContent\(content\)/);
  });
});
