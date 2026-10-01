import { describe, it, expect } from "vitest";
import { buildOutboundMessage, buildImageBlocks, containsSecret, redactSecrets, SLACK_SECTION_CAP, SLACK_TEXT_CAP } from "../src/domain/gateway/slack/message.js";

describe("Slice-11 outbound message — content hygiene (item 7)", () => {
  const opts = { sourceLabel: "vm-openrig-build" };

  it("shows the brief and sender; internal queue identifiers stay behind the message", () => {
    const m = buildOutboundMessage(
      { qitemId: "qitem-abc", summary: "Founder needs a decision", body: "context", destinationSession: "human-founder@kernel" },
      opts,
    );
    expect(m.text).toContain("Founder needs a decision");
    expect(m.text).not.toContain("qitem-abc");
    expect(m.text).not.toContain("human-founder@kernel");
    expect(m.text).toContain("vm-openrig-build");
  });

  it("NEVER forwards a Slack/bearer secret that leaks through a qitem body (redacted)", () => {
    const leaky =
      "here is the token xoxb-EXAMPLE-000000000000-doNotUseFake and hook https://hooks.slack.com/services/T00/B00/xyz and Authorization Bearer EXAMPLEfakebearer000";
    const m = buildOutboundMessage({ qitemId: "q1", summary: "x", body: leaky, destinationSession: "human@kernel" }, opts);
    expect(containsSecret(m.text)).toBe(false);
    expect(m.text).toContain("[redacted-secret]");
    // also in a summary
    const m2 = buildOutboundMessage({ qitemId: "q2", summary: "tok xapp-EXAMPLE-FAKE-token", body: "", destinationSession: "human@kernel" }, opts);
    expect(containsSecret(m2.text)).toBe(false);
    for (const b of m2.blocks) expect(containsSecret(JSON.stringify(b))).toBe(false);
  });

  it("refuses an oversized body with an actionable author correction", () => {
    expect(() => buildOutboundMessage({ qitemId: "q", body: "x".repeat(9000) }, opts)).toThrow(/Shorten the human brief/);
  });

  it("keeps a complete body beyond the former 800-unit excerpt", () => {
    const body = "y".repeat(1000) + " Approve or hold?";
    const m = buildOutboundMessage({ qitemId: "q", summary: "s", body }, opts);
    expect(m.text).toContain(body);
    expect(m.text.length).toBeLessThanOrEqual(SLACK_TEXT_CAP);
    expect(JSON.stringify(m.blocks)).toContain(body);
  });

  it("refuses extra blocks without a complete accessible projection", () => {
    expect(() => buildOutboundMessage({ qitemId: "q", body: "b" }, { ...opts, extraBlocks: [{ type: "section", text: "unrepresented" }] })).toThrow(/accessible fallback/);
  });

  it("redactSecrets/containsSecret round-trip", () => {
    expect(containsSecret("xoxb-1-2-abc")).toBe(true);
    expect(containsSecret(redactSecrets("xoxb-1-2-abc"))).toBe(false);
    expect(containsSecret("nothing sensitive here")).toBe(false);
  });
});

describe("#47 evidence link boundaries", () => {
  const qitem = { qitemId: "q-evidence", summary: "s", body: "b" };
  const opts = { sourceLabel: "vm" };

  it.each([
    "https://user:password@example.invalid/shot.png",
    "https://user@example.invalid/shot.png",
    "https://:password@example.invalid/shot.png",
    "https://user%3Apassword@example.invalid/shot.png",
    "https://[invalid]/shot.png",
    "https://example.invalid:99999/shot.png",
    "https://hooks.slack.com/services/T00/B00/SECRETPART",
    "https://example.invalid/proof?token=xoxb-EXAMPLE-000000-leak",
  ])("never renders an unsafe URL in evidence or image blocks: %s", (url) => {
    const message = buildOutboundMessage(qitem, { ...opts, evidenceLink: url });
    expect(message.text).not.toContain("Evidence:");
    expect(JSON.stringify(message)).not.toContain(url);
    expect(buildImageBlocks([{ imageUrl: url, altText: "attachment" }])).toEqual([]);
  });

  it("preserves percent-encoded URLs and escapes ampersands in the final context and fallback", () => {
    const url = "https://example.invalid/a%20b/%3Cproof%3E?next=%7Cevidence%7C&view=full";
    const escaped = url.replaceAll("&", "&amp;");
    const message = buildOutboundMessage(qitem, { ...opts, evidenceLink: url });
    expect(message.text).toContain(`Evidence: ${escaped}`);
    expect(message.blocks).toContainEqual({
      type: "context", elements: [{ type: "mrkdwn", text: `Evidence: <${escaped}|evidence>` }],
    });
  });

  it.each([
    { name: "link", character: "a", escaped: "a", prefix: "Evidence: <", suffix: "|evidence>" },
    { name: "plain text", character: "|", escaped: "|", prefix: "Evidence: ", suffix: "" },
    { name: "escaped link", character: "&", escaped: "&amp;", prefix: "Evidence: <", suffix: "|evidence>" },
    { name: "escaped plain text", character: "<", escaped: "&lt;", prefix: "Evidence: ", suffix: "" },
  ])("bounds the final $name context at 3000 units without clipping", ({ character, escaped, prefix, suffix }) => {
    const base = "https://example.invalid/";
    const budget = SLACK_SECTION_CAP - prefix.length - base.length - suffix.length;
    const count = Math.floor(budget / escaped.length);
    const padding = "a".repeat(budget % escaped.length);
    const url = base + character.repeat(count) + padding;
    const context = prefix + base + escaped.repeat(count) + padding + suffix;
    const message = buildOutboundMessage(qitem, { ...opts, evidenceLink: url });
    expect(context.length).toBe(SLACK_SECTION_CAP);
    expect(message.blocks).toContainEqual({ type: "context", elements: [{ type: "mrkdwn", text: context }] });
    expect(() => buildOutboundMessage(qitem, { ...opts, evidenceLink: url + character })).toThrow(/evidence context.*maximum 3000/);
  });

  it("includes evidence, images, attribution, mentions and the reconcile marker in the complete fallback budget", () => {
    const evidenceLink = "https://example.invalid/proof?view=full&revision=1";
    const fullOpts = {
      ...opts,
      evidenceLink,
      attribution: { seat: "dev@rig", session: "dev@rig@host" },
      mentionUserId: "U-EVIDENCE",
      reconcileMarker: "(or-mark:d-evidence)",
      mediaRefs: [{ imageUrl: "https://example.invalid/shot.png", altText: "Screenshot & evidence" }],
    };
    const brief = { ...qitem, summary: "s".repeat(1000) };
    const baseline = buildOutboundMessage(brief, fullOpts);
    const body = "b".repeat(1 + SLACK_TEXT_CAP - baseline.text.length);
    const message = buildOutboundMessage({ ...brief, body }, fullOpts);
    expect(message.text.length).toBe(SLACK_TEXT_CAP);
    expect(message.text).toContain("Evidence: " + evidenceLink.replaceAll("&", "&amp;"));
    expect(message.text).toContain("Image: Screenshot &amp; evidence");
    expect(message.text).toContain("from dev@rig@host");
    expect(message.text).toContain("<@U-EVIDENCE>");
    expect(message.text.endsWith(fullOpts.reconcileMarker)).toBe(true);
    expect(() => buildOutboundMessage({ ...brief, body: body + "b" }, fullOpts)).toThrow(/complete fallback.*maximum 3900/);
  });
});

describe("M1 A5b — outbound image attachments (the wired T1076 seam)", () => {
  const opts = { sourceLabel: "vm-openrig-build" };
  const imageBlocks = (m: { blocks: unknown[] }) => m.blocks.filter((b) => (b as { type?: string }).type === "image") as { type: string; image_url: string; alt_text: string }[];

  it("renders a media ref as a Block Kit image block + carries the image description in the fallback", () => {
    const m = buildOutboundMessage(
      { qitemId: "q1", summary: "chart ready", body: "see attached", destinationSession: "human-founder@kernel" },
      { ...opts, mediaRefs: [{ imageUrl: "https://example.com/shot.png", altText: "the screenshot" }] },
    );
    const imgs = imageBlocks(m);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toEqual({ type: "image", image_url: "https://example.com/shot.png", alt_text: "the screenshot" });
    expect(m.text).toContain("Image: the screenshot");
    // text content + hygiene still present
    expect(m.text).toContain("chart ready");
  });

  it("REFUSES a secret-bearing or non-https image_url (item-7 hygiene — never forward a smuggled secret)", () => {
    const blocks = buildImageBlocks([
      { imageUrl: "https://hooks.slack.com/services/T00/B00/SECRETPART", altText: "leak" }, // webhook URL
      { imageUrl: "http://insecure.example.com/x.png", altText: "insecure" },               // non-https
      { imageUrl: "not-a-url", altText: "junk" },
      { imageUrl: "https://ok.example.com/fine.png", altText: "fine" },                      // the only valid one
    ]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { image_url: string }).image_url).toBe("https://ok.example.com/fine.png");
  });

  it("redacts a secret that leaks through alt_text; no media = no image block + no count", () => {
    const blocks = buildImageBlocks([{ imageUrl: "https://ok.example.com/a.png", altText: "tok xoxb-EXAMPLE-000000-leak" }]);
    expect(containsSecret((blocks[0] as { alt_text: string }).alt_text)).toBe(false);
    const plain = buildOutboundMessage({ qitemId: "q2", summary: "x", body: "", destinationSession: "h@kernel" }, opts);
    expect(imageBlocks(plain)).toHaveLength(0);
    expect(plain.text).not.toContain("image attachment");
  });
});
