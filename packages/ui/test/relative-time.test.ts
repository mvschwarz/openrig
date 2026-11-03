// C10: relativeTime — now -> "just now", 5 min -> "5m ago", etc.
import { describe, it, expect } from "vitest";
import { relativeTime } from "../src/lib/relative-time.js";

const NOW = new Date("2026-11-02T05:00:00.000Z").getTime();

describe("relativeTime (C10)", () => {
  it("now -> just now", () => {
    expect(relativeTime(new Date(NOW).toISOString(), NOW)).toBe("just now");
  });
  it("5 min -> 5m ago", () => {
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m ago");
  });
  it("3 h -> 3h ago", () => {
    expect(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3h ago");
  });
  it("2 d -> 2d ago", () => {
    expect(relativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe("2d ago");
  });
});
