import { describe, it, expect } from "vitest";
import {
  detectAmbientClockHazard,
  assertNoAmbientClock,
  AmbientClockHazardError,
  TEST_CLOCK_ENV_VARS,
  prepareHermeticEnv,
} from "./helpers/hermetic-env.js";

// Slice 51-01 items 6-8 — the A3-R3 injected-clock env guard + injection plumb.
//
// OPENRIG_TEST_CLOCK_NOW is the deterministic-clock injection var the compaction
// bridge reads (falling back to new Date() when ABSENT = production). A PRESENT
// clock var in a REAL seat silently FREEZES production compaction stamps — the
// temporal edition of the silent-retarget class. So the hermetic helper hard-refuses
// an ambient clock var it did not set itself (belt), exactly like a daemon-target
// var; the scaffold sets it ONLY via injectClockNow (self-set injection).

const cleanBase = () => ({ HOME: "/base-home", PATH: "/usr/bin", TERM: "xterm" });

describe("ambient test-clock hazard guard (A3-R3 leak pin)", () => {
  it("detects a present OPENRIG_TEST_CLOCK_NOW, treats empty/absent as clean", () => {
    expect(TEST_CLOCK_ENV_VARS).toContain("OPENRIG_TEST_CLOCK_NOW");
    expect(detectAmbientClockHazard({ OPENRIG_TEST_CLOCK_NOW: "2020-01-01T00:00:00.000Z" }))
      .toEqual({ name: "OPENRIG_TEST_CLOCK_NOW", value: "2020-01-01T00:00:00.000Z" });
    expect(detectAmbientClockHazard({ OPENRIG_TEST_CLOCK_NOW: "" })).toBeNull();
    expect(detectAmbientClockHazard({})).toBeNull();
  });

  it("assertNoAmbientClock hard-refuses a present clock var (named, fail-closed)", () => {
    expect(() => assertNoAmbientClock({ OPENRIG_TEST_CLOCK_NOW: "frozen" })).toThrow(AmbientClockHazardError);
    expect(() => assertNoAmbientClock(cleanBase())).not.toThrow();
  });

  it("prepareHermeticEnv REFUSES a base env carrying a leaked clock var (the leak pin), before any fs side effect", () => {
    let err: unknown;
    try {
      prepareHermeticEnv({ baseEnv: { ...cleanBase(), OPENRIG_TEST_CLOCK_NOW: "leaked" } });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AmbientClockHazardError);
  });

  it("injectClockNow sets the clock var in the scaffold's OWN child env (self-set injection), then cleans up", () => {
    const scaffold = prepareHermeticEnv({ baseEnv: cleanBase(), injectClockNow: "2021-06-06T06:06:06.000Z" });
    try {
      expect(scaffold.env.OPENRIG_TEST_CLOCK_NOW).toBe("2021-06-06T06:06:06.000Z");
    } finally {
      scaffold.cleanup();
    }
  });

  it("omitting injectClockNow leaves the clock var UNSET in the child env (absence = production real-time)", () => {
    const scaffold = prepareHermeticEnv({ baseEnv: cleanBase() });
    try {
      expect(scaffold.env.OPENRIG_TEST_CLOCK_NOW).toBeUndefined();
    } finally {
      scaffold.cleanup();
    }
  });
});
