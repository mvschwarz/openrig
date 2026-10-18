import { describe, expect, it } from "vitest";
import { findFrontmatterBlock } from "../src/domain/frontmatter.js";

describe("shared frontmatter boundary", () => {
  it("preserves the original LF grammars, including whitespace backtracking and body offsets", () => {
    for (const openingWhitespace of [false, true]) {
      for (const consumeClosingNewline of [false, true]) {
        for (const opener of ["---\n", "--- \n", "---\n\n", "---\t\n", "---\n \n"]) {
          for (const yaml of ["", "name: demo", "\nname: demo", "name: demo\n", "description: |\n  line\n  two"]) {
            for (const closing of ["---", "----", "---suffix"]) {
              for (const suffix of ["", "\n", "\n\n", "\r\n", "inline"]) {
                for (const body of ["", "body\n", "# Body\r\n\u0000---\n"]) {
                  const raw = opener + yaml + "\n" + closing + suffix + body;
                  // Frozen pre-change reader grammars are the compatibility oracle.
                  const old = (openingWhitespace ? /^---\s*\n([\s\S]*?)\n---/ : /^---\n([\s\S]*?)\n---/).exec(raw);
                  let expected = null;
                  if (old) {
                    let bodyStart = old[0].length;
                    if (consumeClosingNewline && raw[bodyStart] === "\n") bodyStart++;
                    expected = { yaml: old[1], bodyStart };
                  }
                  expect(findFrontmatterBlock(raw, { openingWhitespace, consumeClosingNewline })).toEqual(expected);
                }
              }
            }
          }
        }
      }
    }
  });

  it("returns CRLF spans without rewriting a mixed-ending body", () => {
    const raw = "---\r\nname: demo\r\n---\r\n# Body\r\n\u0000\n";
    const block = findFrontmatterBlock(raw, { consumeClosingNewline: true });
    expect(block).toEqual({ yaml: "name: demo", bodyStart: 22 });
    expect(raw.slice(block!.bodyStart)).toBe("# Body\r\n\u0000\n");
  });
});
