import { describe, it, expect } from "vitest";
import { buildOutboundMessage, buildImageBlocks, containsSecret, redactSecrets, SLACK_TEXT_CAP } from "../src/domain/gateway/slack/message.js";

describe("Slice-11 outbound message — content hygiene (item 7)", () => {
  const opts = { sourceLabel: "vm-openrig-build" };

  it("includes summary + qitem id + destination + source label", () => {
    const m = buildOutboundMessage(
      { qitemId: "qitem-abc", summary: "Founder needs a decision", body: "context", destinationSession: "human-founder@kernel" },
      opts,
    );
    expect(m.text).toContain("Founder needs a decision");
    expect(m.text).toContain("qitem-abc");
    expect(m.text).toContain("human-founder@kernel");
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

  it("caps text under the Slack limit", () => {
    const m = buildOutboundMessage({ qitemId: "q", summary: "s", body: "x".repeat(9000), destinationSession: "human@kernel" }, opts);
    expect(m.text.length).toBeLessThanOrEqual(SLACK_TEXT_CAP);
  });

  it("bounds the body excerpt (default 800)", () => {
    const m = buildOutboundMessage({ qitemId: "q", summary: "s", body: "y".repeat(5000), destinationSession: "d" }, opts);
    // body section is the excerpt, not the whole 5000
    const bodyBlock = JSON.stringify(m.blocks).match(/y+/)?.[0] ?? "";
    expect(bodyBlock.length).toBeLessThanOrEqual(800);
  });

  it("T1076: emits Block Kit blocks PLUS a text fallback, and accepts extra blocks", () => {
    const extra = [{ type: "image", image_url: "x", alt_text: "future" }];
    const m = buildOutboundMessage({ qitemId: "q", summary: "s", body: "b", destinationSession: "d" }, { ...opts, extraBlocks: extra });
    expect(typeof m.text).toBe("string");
    expect(m.text.length).toBeGreaterThan(0);
    expect(Array.isArray(m.blocks)).toBe(true);
    expect(m.blocks.length).toBeGreaterThanOrEqual(3); // summary + body + context
    expect(m.blocks).toContainEqual(extra[0]); // extension point works
  });

  it("redactSecrets/containsSecret round-trip", () => {
    expect(containsSecret("xoxb-1-2-abc")).toBe(true);
    expect(containsSecret(redactSecrets("xoxb-1-2-abc"))).toBe(false);
    expect(containsSecret("nothing sensitive here")).toBe(false);
  });
});

describe("M1 A5b — outbound image attachments (the wired T1076 seam)", () => {
  const opts = { sourceLabel: "vm-openrig-build" };
  const imageBlocks = (m: { blocks: unknown[] }) => m.blocks.filter((b) => (b as { type?: string }).type === "image") as { type: string; image_url: string; alt_text: string }[];

  it("renders a media ref as a Block Kit image block + notes the attachment count in the fallback", () => {
    const m = buildOutboundMessage(
      { qitemId: "q1", summary: "chart ready", body: "see attached", destinationSession: "human-founder@kernel" },
      { ...opts, mediaRefs: [{ imageUrl: "https://example.com/shot.png", altText: "the screenshot" }] },
    );
    const imgs = imageBlocks(m);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toEqual({ type: "image", image_url: "https://example.com/shot.png", alt_text: "the screenshot" });
    expect(m.text).toContain("1 image attachment");
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
