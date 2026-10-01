import { afterEach, describe, expect, it } from "vitest";
import { parseSqliteUtcMs } from "../src/domain/sqlite-time.js";

describe("parseSqliteUtcMs", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("reads a zone-less SQLite datetime('now') stamp as UTC, not host-local time", () => {
    // A non-UTC host is where a bare Date.parse skews the stamp by the UTC offset.
    process.env.TZ = "America/Los_Angeles";
    expect(parseSqliteUtcMs("2026-09-28 02:45:08")).toBe(Date.UTC(2026, 8, 28, 2, 45, 8));
    // Same for the T-separated form: no zone marker means UTC, whatever the separator.
    expect(parseSqliteUtcMs("2026-09-28T02:45:08")).toBe(Date.UTC(2026, 8, 28, 2, 45, 8));
  });

  it("leaves zoned ISO values unchanged and returns NaN for garbage", () => {
    expect(parseSqliteUtcMs("2026-09-28T02:45:08.245Z")).toBe(Date.parse("2026-09-28T02:45:08.245Z"));
    expect(parseSqliteUtcMs("2026-09-28T02:45:08+02:00")).toBe(Date.UTC(2026, 8, 28, 0, 45, 8));
    expect(parseSqliteUtcMs("not a date")).toBeNaN();
  });
});
