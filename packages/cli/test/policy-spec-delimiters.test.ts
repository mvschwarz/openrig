import { describe, expect, it } from "vitest";
import { parsePolicySpec as parseCli } from "../src/lib/permission-policy/policy-spec.js";
import { parsePolicySpec as parseDaemon } from "../../daemon/src/domain/permission-policy/policy-spec.js";

for (const [owner, parse] of [["cli", parseCli], ["daemon", parseDaemon]] as const) {
  describe(`${owner} policy frontmatter preserves the existing grammar`, () => {
    for (const newline of ["\n", "\r\n"]) {
      it.each(["----", "---suffix"])(`keeps closing-prefix body bytes with ${JSON.stringify(newline)}: %s`, (closing) => {
        const result = parse(["---", "source: builtin", "name: standard", closing, "body"].join(newline));
        if ("error" in result) throw new Error(result.error);
        expect(result.frontmatter).toEqual({ source: "builtin", name: "standard" });
        expect(result.body).toBe(closing.slice(3) + newline + "body");
      });
    }
    it("preserves a mixed-ending body after an LF header", () => {
      const body = "\r\n# Policy\r\n---suffix is body text\n";
      const result = parse("---\nsource: builtin\nname: standard\n---" + body);
      if ("error" in result) throw new Error(result.error);
      expect(result.body).toBe(body);
    });
    it("preserves body bytes after a CRLF closing line", () => {
      const body = "# Policy\r\n---suffix is body text\n\u0000\n";
      const result = parse("---\r\nsource: builtin\r\nname: standard\r\n---\r\n" + body);
      if ("error" in result) throw new Error(result.error);
      expect(result.body).toBe(body);
    });
  });
}
