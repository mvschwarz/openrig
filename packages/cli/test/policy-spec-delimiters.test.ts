import { describe, expect, it } from "vitest";
import { parsePolicySpec as parseCli } from "../src/lib/permission-policy/policy-spec.js";
import { parsePolicySpec as parseDaemon } from "../../daemon/src/domain/permission-policy/policy-spec.js";

for (const [owner, parse] of [["cli", parseCli], ["daemon", parseDaemon]] as const) {
  describe(`${owner} policy frontmatter delimiter boundaries`, () => {
    for (const newline of ["\n", "\r\n"]) {
      it.each(["----", "---suffix"])(`rejects closing %s with ${JSON.stringify(newline)} line ends`, (closing) => {
        const raw = ["---", "source: builtin", "name: standard", closing, "body"].join(newline);
        expect("error" in parse(raw)).toBe(true);
      });
    }
    it.each(["", "\n", "\r\n"])("accepts a complete closing line followed by %j", (suffix) => {
      const result = parse("---\nsource: builtin\nname: standard\n---" + suffix);
      expect("error" in result).toBe(false);
      if ("error" in result) throw new Error(result.error);
      expect(result.body).toBe("");
    });
    it("preserves body bytes after a CRLF closing line", () => {
      const body = "# Policy\r\n---suffix is body text\r\n";
      const result = parse("---\r\nsource: builtin\r\nname: standard\r\n---\r\n" + body);
      expect("error" in result).toBe(false);
      if ("error" in result) throw new Error(result.error);
      expect(result.body).toBe(body);
    });
  });
}
