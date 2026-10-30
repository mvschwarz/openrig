import { describe, it, expect } from "vitest";
import { buildOutboundMessage, containsSecret, markdownToSlackMrkdwn } from "../src/domain/gateway/slack/message.js";

const md = markdownToSlackMrkdwn;

describe("Markdown in a row body renders as Slack mrkdwn", () => {
  it("turns **bold** and __bold__ into *bold*", () => {
    expect(md("a **strong** word and __another__ one")).toBe("a *strong* word and *another* one");
  });

  it("turns # and ## headings into a bold line", () => {
    expect(md("# Title\ntext\n## Next step ##")).toBe("*Title*\ntext\n*Next step*");
  });

  it("turns a safe https [text](url) into <url|text>", () => {
    expect(md("see [the PR](https://example.com/pr/1?a=1&b=2) now")).toBe("see <https://example.com/pr/1?a=1&amp;b=2|the PR> now");
  });

  it("leaves a non-https or unsafe link as escaped text", () => {
    expect(md("[x](http://example.com)")).toBe("[x](http://example.com)");
    expect(md("[x](https://user:pw@example.com)")).toBe("[x](https://user:pw@example.com)");
    expect(md("[a|b](https://example.com)")).toBe("[a|b](https://example.com)");
  });

  it("turns -, * and + list items into bullets, and indented items into ◦", () => {
    expect(md("- one\n* two\n+ three\n  - nested\n    * deeper")).toBe("• one\n• two\n• three\n  ◦ nested\n    ◦ deeper");
  });

  it("does not read a *bold* line as a list item", () => {
    expect(md("*bold* start\n* item")).toBe("*bold* start\n• item");
  });

  it("keeps numbered lists as text", () => {
    expect(md("1. first\n2. second")).toBe("1. first\n2. second");
  });

  it("leaves code spans and fenced blocks untouched apart from escaping", () => {
    expect(md("run `**x** [a](https://e.com)` here")).toBe("run `**x** [a](https://e.com)` here");
    expect(md("```\n# not a heading\n- not a list\n**x** <y>\n```\n- a list")).toBe(
      "```\n# not a heading\n- not a list\n**x** &lt;y&gt;\n```\n• a list",
    );
  });

  it("keeps a code span inside a link label", () => {
    expect(md("[`npm test`](https://example.com)")).toBe("<https://example.com|`npm test`>");
  });

  it("still neutralizes Slack control syntax and redacts secrets", () => {
    expect(md("**hi** <!channel> <@U123> & co")).toBe("*hi* &lt;!channel&gt; &lt;@U123&gt; &amp; co");
    expect(md("[a](https://example.com/<!here>)")).toBe("[a](https://example.com/&lt;!here&gt;)");
    const out = md("- token xoxb-EXAMPLE-000000000000-doNotUseFake\n[hook](https://hooks.slack.com/services/T00/B00/xyz)");
    expect(containsSecret(out)).toBe(false);
    expect(out).toContain("• token [redacted-secret]");
    expect(out).not.toContain("<");
  });

  it("is applied to the body section and the fallback text of a posted message", () => {
    const m = buildOutboundMessage({ qitemId: "q", summary: "s", body: "## Plan\n- **ship** [it](https://example.com)" }, { sourceLabel: "host" });
    const expected = "*Plan*\n• *ship* <https://example.com|it>";
    expect(m.text).toContain(expected);
    expect(JSON.stringify(m.blocks)).toContain(JSON.stringify(expected).slice(1, -1));
  });
});
