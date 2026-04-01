import { describe, it, expect } from "vitest";
import { shortId } from "../src/lib/display-id.js";

describe("shortId", () => {
  it("returns last 6 characters by default", () => {
    const id = "01HXYZ123456ABCDEF";
    expect(shortId(id)).toBe(id.slice(-6));
    expect(shortId(id)).toBe("ABCDEF");
  });

  it("returns last N characters with custom length", () => {
    const id = "01HXYZ123456ABCDEF";
    expect(shortId(id, 8)).toBe(id.slice(-8));
  });

  it("returns full ID if shorter than length", () => {
    expect(shortId("ABC", 6)).toBe("ABC");
  });
});
