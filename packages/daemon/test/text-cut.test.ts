import { describe, expect, it } from "vitest";
import { sliceWhole } from "../src/domain/text-cut.js";

describe("sliceWhole", () => {
  it("keeps up to `end` UTF-16 units", () => {
    expect(sliceWhole("abcdef", 3)).toBe("abc");
    expect(sliceWhole("abc", 10)).toBe("abc");
  });

  it("backs off one unit instead of ending on half a surrogate pair", () => {
    expect(sliceWhole("ab😀cd", 3)).toBe("ab");
    expect(sliceWhole("ab😀cd", 4)).toBe("ab😀");
  });
});
