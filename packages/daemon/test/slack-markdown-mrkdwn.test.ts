import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBodyBlocks, buildOutboundMessage, containsSecret, escapeSlackText, markdownToSlackMrkdwn, openFenceAfter, splitForSlack } from "../src/domain/gateway/slack/message.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";

const md = markdownToSlackMrkdwn;
type Item = Array<Record<string, unknown>>;
const list = (lists: Array<{ style: string; indent: number; offset?: number; items: Item[] }>) => ({
  type: "rich_text",
  elements: lists.map(({ style, indent, offset, items }) => ({ type: "rich_text_list", style, indent, ...(offset ? { offset } : {}), elements: items.map((elements) => ({ type: "rich_text_section", elements })) })),
});
const t = (text: string, style?: Record<string, boolean>) => (style ? { type: "text", text, style } : { type: "text", text });

describe("Markdown in a row body renders as Slack mrkdwn", () => {
  it("turns **bold** and __bold__ into *bold*", () => {
    expect(md("a **strong** word and __another__ one")).toBe("a *strong* word and *another* one");
  });

  it("turns # and ## headings into a bold line", () => {
    expect(md("# Title\ntext\n## Next step ##")).toBe("*Title*\ntext\n*Next step*");
    expect(md("## **Plan**\n# __Done__")).toBe("*Plan*\n*Done*");
  });

  it("turns a safe https [text](url) into <url|text>", () => {
    expect(md("see [the PR](https://example.com/pr/1?a=1&b=2) now")).toBe("see <https://example.com/pr/1?a=1&amp;b=2|the PR> now");
  });

  it("leaves a non-https or unsafe link as escaped text", () => {
    expect(md("[x](http://example.com)")).toBe("[x](http://example.com)");
    expect(md("[x](https://user:pw@example.com)")).toBe("[x](https://user:pw@example.com)");
    expect(md("[a|b](https://example.com)")).toBe("[a|b](https://example.com)");
  });

  it("writes -, * and + list items as \"- \", keeping indentation", () => {
    expect(md("- one\n* two\n+ three\n  - nested\n    * deeper")).toBe("- one\n- two\n- three\n  - nested\n    - deeper");
  });

  it("does not read a *bold* line as a list item", () => {
    expect(md("*bold* start\n* item")).toBe("*bold* start\n- item");
  });

  it("keeps numbered lists as text", () => {
    expect(md("1. first\n2. second")).toBe("1. first\n2. second");
  });

  it("leaves code spans and fenced blocks untouched apart from escaping", () => {
    expect(md("run `**x** [a](https://e.com)` here")).toBe("run `**x** [a](https://e.com)` here");
    expect(md("```\n# not a heading\n- not a list\n**x** <y>\n```\n- a list")).toBe(
      "```\n# not a heading\n- not a list\n**x** &lt;y&gt;\n```\n- a list",
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
    expect(out).toContain("- token [redacted-secret]");
    expect(out).not.toContain("<");
  });

  it("is applied to the body section and the fallback text of a posted message", () => {
    const m = buildOutboundMessage({ qitemId: "q", summary: "s", body: "## Plan\n- **ship** [it](https://example.com)" }, { sourceLabel: "host" });
    expect(m.text).toContain("*Plan*\n- *ship* <https://example.com|it>");
    expect(m.blocks).toContainEqual({ type: "section", text: { type: "mrkdwn", text: "*Plan*" } });
    expect(m.blocks).toContainEqual(list([{ style: "bullet", indent: 0, items: [[{ type: "text", text: "ship", style: { bold: true } }, { type: "text", text: " " }, { type: "link", url: "https://example.com", text: "it" }]] }]));
  });

  it("keeps input that looks like an internal marker literal, without growing the body", () => {
    expect(md("before \uE0000\uE001 after <0> <1>")).toBe("before \uE0000\uE001 after &lt;0&gt; &lt;1&gt;");
    expect(md("`hello` <0>")).toBe("`hello` &lt;0&gt;");
    const long = "`" + "x".repeat(1600) + "` <0> \uE0000\uE001";
    expect(md(long).length).toBeLessThanOrEqual(escapeSlackText(long).length);
    expect(() => buildOutboundMessage({ qitemId: "q", summary: "s", body: long }, { sourceLabel: "host" })).not.toThrow();
  });

  it("checks a link label for | after restoring its code", () => {
    expect(md("[`a|b`](https://example.com)")).toBe("[`a|b`](https://example.com)");
  });

  it("closes a fence only with the same character and at least the opening length", () => {
    expect(md("````\n```\n# literal\n```\n````\n# heading")).toBe("````\n```\n# literal\n```\n````\n*heading*");
    expect(md("~~~\n# literal\n**literal**\n```\n~~~\n**bold**")).toBe("~~~\n# literal\n**literal**\n```\n~~~\n*bold*");
  });

  it("continues an open fence into the next part of a split brief", () => {
    const body = "```\n" + "x".repeat(1900) + "\n# literal\n**literal**\n```\n# after";
    const pieces = splitForSlack(body, () => 1910);
    expect(pieces.length).toBe(2);
    expect(md(pieces[0]!).endsWith("\n```")).toBe(true);
    const second = md(pieces[1]!, openFenceAfter(pieces[0]!));
    expect(second.startsWith("```\n# literal\n**literal**\n```")).toBe(true);
    expect(second.endsWith("*after*")).toBe(true);
    expect(md("~~~\nx", "~~~")).toBe("~~~\nx");
  });

  it("delivers a code block split across Slack messages as code in every part", async () => {
    const home = mkdtempSync(join(tmpdir(), "slack-mrkdwn-"));
    try {
      const posts: Array<{ blocks: Array<{ text?: { text: string } }> }> = [];
      const deliver = subsystemSlackDeliver({
        delivered: new SeenStore(join(home, "delivered")), attempted: new SeenStore(join(home, "attempted")), outboundSeen: new SeenStore(join(home, "seen")),
        botToken: "synthetic", channel: "C", sourceLabel: "fixture",
        fetchImpl: async (_url, init) => {
          posts.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ ok: true, ts: `${posts.length}.1` }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      const body = "```\n" + "x ".repeat(2000) + "\n# literal\n- literal\n**literal**\n```\n## Next\n- item";
      const decision: OutboundDecision = { kind: "outbound_decision", decisionId: "d", op: "post_message", entityBindingRef: "h@external",
        payload: { qitemId: "q-d", summary: "s", body, sourceSession: "a@rig", destinationSession: "h@external" } };
      expect(await deliver(decision)).toEqual({ ok: true });
      expect(posts.length).toBeGreaterThan(1);
      const last = posts.at(-1)!.blocks;
      for (const p of posts) {
        const code = p.blocks.map((b) => b.text?.text ?? "").join("\n").split("```").length - 1;
        expect(code % 2).toBe(0);
      }
      expect(last.map((b) => b.text?.text ?? "").join("\n")).toContain("# literal\n- literal\n**literal**\n```\n*Next*");
      expect(last.find((b) => b.text?.text.includes("# literal"))!.text!.text.startsWith("```\n")).toBe(true);
      expect(last).toContainEqual(list([{ style: "bullet", indent: 0, items: [[{ type: "text", text: "item" }]] }]));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps a Slack-format link written by hand live, under the same checks", () => {
    expect(md("- <https://github.com/o/r/pull/1|PR #1> and <https://example.com/a?b=1&c=2>")).toBe(
      "- <https://github.com/o/r/pull/1|PR #1> and <https://example.com/a?b=1&amp;c=2>",
    );
    expect(md("<http://example.com|x> <https://user:pw@example.com|x> <!channel> <@U1> <https://e.com|a|b>")).toBe(
      "&lt;http://example.com|x&gt; &lt;https://user:pw@example.com|x&gt; &lt;!channel&gt; &lt;@U1&gt; &lt;https://e.com|a|b&gt;",
    );
    expect(md("`<https://example.com|x>`")).toBe("`&lt;https://example.com|x&gt;`");
  });
});

describe("list items in a row body render as native Slack lists", () => {
  it("groups items into rich_text lists, nested by indent, bullet or ordered", () => {
    expect(buildBodyBlocks("Intro\n- one\n* two\n  + nested\n- three\n1. first\n2) second\nOutro")).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Intro" } },
      list([
        { style: "bullet", indent: 0, items: [[t("one")], [t("two")]] },
        { style: "bullet", indent: 1, items: [[t("nested")]] },
        { style: "bullet", indent: 0, items: [[t("three")]] },
        { style: "ordered", indent: 0, items: [[t("first")], [t("second")]] },
      ]),
      { type: "section", text: { type: "mrkdwn", text: "Outro" } },
    ]);
  });

  it("styles bold and code, and links only safe https URLs", () => {
    const [block] = buildBodyBlocks("- **a** __b__ *c* `**d**` [e](https://e.com) <https://f.com|f> <https://g.com> [h](http://h.com) <https://u:p@i.com|i>") as Array<{ elements: Array<{ elements: Array<{ elements: unknown[] }> }> }>;
    expect(block!.elements[0]!.elements[0]!.elements).toEqual([
      t("a", { bold: true }), t(" "), t("b", { bold: true }), t(" "), t("c", { bold: true }), t(" "), t("**d**", { code: true }), t(" "),
      { type: "link", url: "https://e.com", text: "e" }, t(" "), { type: "link", url: "https://f.com", text: "f" }, t(" "),
      { type: "link", url: "https://g.com" }, t(" [h](http://h.com) <https://u:p@i.com|i>"),
    ]);
  });

  it("keeps mentions as literal text, redacts secrets, and never emits empty text", () => {
    const json = JSON.stringify(buildBodyBlocks("- <!channel> <@U1> xoxb-EXAMPLE-000000000000-doNotUseFake\n- "));
    expect(json).toContain('"text":"<!channel> <@U1> [redacted-secret]"');
    expect(containsSecret(json)).toBe(false);
    expect(json).not.toContain('"text":""');
  });

  it("leaves list lines inside a code fence in the mrkdwn section", () => {
    expect(buildBodyBlocks("```\n- not a list\n```\n- a list")).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "```\n- not a list\n```" } },
      list([{ style: "bullet", indent: 0, items: [[t("a list")]] }]),
    ]);
    expect(buildBodyBlocks("- still code\n```", "```")[0]).toEqual({ type: "section", text: { type: "mrkdwn", text: "```\n- still code\n```" } });
  });

  it("falls back to one mrkdwn section when list runs would pass 50 blocks", () => {
    const body = Array.from({ length: 30 }, (_, i) => `text ${i}\n- item ${i}`).join("\n");
    const m = buildOutboundMessage({ qitemId: "q", summary: "s", body }, { sourceLabel: "host" });
    expect(m.blocks.length).toBeLessThanOrEqual(50);
    expect(m.blocks.some((b) => (b as { type: string }).type === "rich_text")).toBe(false);
    expect(m.text).toContain("text 29\n- item 29");
  });

  it("never emits an empty section around a list", () => {
    for (const body of ["# \n- item", "- item\n# ", "\n# \n- item\n  \n"]) {
      expect(buildBodyBlocks(body)).toEqual([list([{ style: "bullet", indent: 0, items: [[t("item")]] }])]);
    }
  });

  it("keeps ordered numbering when a list starts later or resumes after nesting", () => {
    expect(buildBodyBlocks("5. five\n6. six")).toEqual([list([{ style: "ordered", indent: 0, offset: 4, items: [[t("five")], [t("six")]] }])]);
    expect(buildBodyBlocks("1. one\n   - sub\n2. two")).toEqual([list([
      { style: "ordered", indent: 0, items: [[t("one")]] },
      { style: "bullet", indent: 1, items: [[t("sub")]] },
      { style: "ordered", indent: 0, offset: 1, items: [[t("two")]] },
    ])]);
  });

  it("adds no empty code section before a list when a part continues a code block", () => {
    const m = buildOutboundMessage({ qitemId: "q", summary: "s", body: "code\n```\n- one\n- two", bodyOpenFence: "```" }, { sourceLabel: "host" });
    const body = m.blocks.slice(2);
    expect(body).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "```\ncode\n```" } },
      list([{ style: "bullet", indent: 0, items: [[t("one")], [t("two")]] }]),
    ]);
  });
});
