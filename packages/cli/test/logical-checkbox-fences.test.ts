import { describe, it, expect } from "vitest";
import { parseLogicalCheckboxes } from "../src/lib/scope/logical-checkbox.js";

import { parseProofContract } from "../src/commands/proof.js";

describe("proof-contract fenced examples", () => {
  it.each(["```", "~~~"])("excludes examples inside %s fences and keeps source lines", (marker) => {
    const block = [
      "- [ ] first promise",
      "  continued",
      `${marker}markdown`,
      "- [x] example only",
      marker,
      "- [x] second promise",
    ].join("\n");
    expect(parseLogicalCheckboxes(block)).toEqual([
      { checked: false, rawText: "first promise continued", sourceLine: 1 },
      { checked: true, rawText: "second promise", sourceLine: 6 },
    ]);
  });

  it("keeps shorter, mismatched and annotated closers inside the example", () => {
    const block = ["````md", "```", "~~~", "```` text", "- [ ] example", "`````", "- [ ] real"].join("\n");
    expect(parseLogicalCheckboxes(block)).toEqual([
      { checked: false, rawText: "real", sourceLine: 7 },
    ]);
  });

  it("does not treat inline backticks as an opener", () => {
    expect(parseLogicalCheckboxes("```inline```\n- [ ] real")).toEqual([
      { checked: false, rawText: "real", sourceLine: 2 },
    ]);
  });

  it("keeps evidence positions stable through the proof-contract reader", () => {
    const document = "## Proof contract\n- [ ] first\n```md\n- [x] example\n```\n- [ ] second\n";
    expect(parseProofContract(document)).toEqual(["first", "second"]);
  });

  it("ignores the remainder of an unclosed example", () => {
    expect(parseLogicalCheckboxes("~~~md\n- [ ] example")).toEqual([]);
  });
});
