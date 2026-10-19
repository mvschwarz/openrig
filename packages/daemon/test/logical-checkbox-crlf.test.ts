import { describe, it, expect } from "vitest";
import { parseLogicalCheckboxes } from "../src/domain/scope/logical-checkbox.js";

// A SPEC.md or proof-contract block saved with CRLF endings must parse like its LF twin:
// the `.` in the checkbox pattern does not match the `\r` a "\n" split leaves behind.
describe("parseLogicalCheckboxes with CRLF line endings", () => {
  const lf = [
    "- [x] first promise",
    "  continued on a deeper line",
    "- [ ] second promise",
    "",
    "- [X] third promise",
  ].join("\n");

  it("returns the same items as the LF text", () => {
    const expected = parseLogicalCheckboxes(lf);
    expect(expected).toHaveLength(3);
    expect(parseLogicalCheckboxes(lf.replace(/\n/g, "\r\n"))).toEqual(expected);
  });

  it("keeps the joined continuation free of carriage returns", () => {
    const [first] = parseLogicalCheckboxes(lf.replace(/\n/g, "\r\n"));
    expect(first!.rawText).toBe("first promise continued on a deeper line");
    expect(first!.sourceLine).toBe(1);
  });
});
