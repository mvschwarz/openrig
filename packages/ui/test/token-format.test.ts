import { describe, expect, it } from "vitest";
import { formatCompactTokenCount, formatTokenTotalTitle, sumTokenCounts } from "../src/lib/token-format.js";

describe("token-format", () => {
  it("formats compact token totals for graph cards", () => {
    expect(formatCompactTokenCount(999)).toBe("999");
    expect(formatCompactTokenCount(1_234)).toBe("1.2k");
    expect(formatCompactTokenCount(123_000)).toBe("123k");
    expect(formatCompactTokenCount(1_000_000)).toBe("1m");
    expect(formatCompactTokenCount(123_000_000)).toBe("123m");
  });

  it("sums known input and output token counts", () => {
    expect(sumTokenCounts(120_000, 14_000)).toBe(134_000);
    expect(sumTokenCounts(null, 14_000)).toBe(14_000);
    expect(sumTokenCounts(null, undefined)).toBeNull();
  });

  it("builds an exact tooltip for available token counts", () => {
    expect(formatTokenTotalTitle(120_000, 14_000)).toBe([
      "Tokens: 134,000",
      "Input: 120,000",
      "Output: 14,000",
    ].join("\n"));
  });
});
