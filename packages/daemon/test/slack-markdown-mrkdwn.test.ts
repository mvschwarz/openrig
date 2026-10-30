import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOutboundMessage, containsSecret, escapeSlackText, markdownToSlackMrkdwn, openFenceAfter, splitForSlack } from "../src/domain/gateway/slack/message.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";

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
    const second = md(pieces[1]!, openFenceAfter(pieces[0]!));
    expect(second).toContain("# literal\n**literal**\n```");
    expect(second.endsWith("*after*")).toBe(true);
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
      const last = posts.at(-1)!.blocks.map((b) => b.text?.text ?? "").join("\n");
      expect(last).toContain("# literal\n- literal\n**literal**\n```\n*Next*\n• item");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
