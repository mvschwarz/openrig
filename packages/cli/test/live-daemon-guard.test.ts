// Hermeticity guard — WRITE-direction sibling of the gate's hermetic checker.
// A cli TEST process must not be able to reach the LIVE daemon by default STATE_FILE
// discovery; an unscoped WRITE (e.g. `rig broadcast`) would then leak into the live
// topology. The guard fails LOUD when the resolved OpenRig home is not fixture-scoped.
//
// This is the KNOWN-NEGATIVE: a check that can only pass is not a check — so we prove
// the guard FIRES on a deliberately-live home, and passes on a fixture home.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertFixtureScopedHome } from "./live-daemon-guard.js";
import { FIXTURE_HOME_MARKER } from "../src/openrig-compat.js";

describe("live-daemon hermeticity guard", () => {
  it("KNOWN-NEGATIVE: THROWS on a live (non-fixture) home — the guard fires", () => {
    const liveHome = fs.mkdtempSync(path.join(os.tmpdir(), "live-home-")); // no fixture marker
    try {
      expect(() => assertFixtureScopedHome(liveHome)).toThrow(/HERMETICITY GUARD|live/i);
    } finally {
      fs.rmSync(liveHome, { recursive: true, force: true });
    }
  });

  it("PASSES on a fixture-scoped home (carries the marker)", () => {
    const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-home-"));
    fs.writeFileSync(path.join(fixtureHome, FIXTURE_HOME_MARKER), "");
    try {
      expect(() => assertFixtureScopedHome(fixtureHome)).not.toThrow();
    } finally {
      fs.rmSync(fixtureHome, { recursive: true, force: true });
    }
  });
});
