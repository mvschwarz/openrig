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
