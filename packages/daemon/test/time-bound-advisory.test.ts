import { describe, it, expect } from "vitest";
import { isRecognisedDateOrTime, timeBoundAdvisory } from "../src/domain/time-bound-advisory.js";

describe("time bound advisory", () => {
  it.each([
    "2026", "2026-10", "2026-10-14", "2026-10-14T09", "2026-10-14T09:30", "2026-10-14T09:30:00",
    "2026-10-14T09:30:00.123Z", "2026-10-14T09Z", "2026-10-14T09:30:00+05:30", "2024-02-29T23:59:59Z",
  ])("recognises %s as a date or time", (value) => {
    expect(isRecognisedDateOrTime(value)).toBe(true);
    expect(timeBoundAdvisory("since", value, "installedAt")).toBeUndefined();
  });

  it.each([
    "garbage", "2026-13-45", "2026-00-10", "2026-02-30", "2025-02-29", "2026-10-14T24", "2026-10-14T09:60",
    "Oct 14 2026", "2026-10-14 09:00", "1760000000", " 2026-10-14",
  ])("does not recognise %s", (value) => {
    expect(isRecognisedDateOrTime(value)).toBe(false);
    expect(timeBoundAdvisory("since", value, "installedAt")).toBe(
      `since "${value}" was not recognised as a date or time; the existing text comparison against installedAt was used`);
  });

  it("gives no advisory for an empty or omitted bound", () => {
    expect(timeBoundAdvisory("since", undefined, "installedAt")).toBeUndefined();
    expect(timeBoundAdvisory("since", "", "installedAt")).toBeUndefined();
  });
});
