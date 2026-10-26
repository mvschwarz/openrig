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
    expect(message.text).toContain("From dev@rig@host");
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

describe("#1013 — a workflow gate parked on a human seat renders the question, not the agent packet", () => {
  // The packet exactly as workflowHandoffBody builds it (projector :1781-1825): agent-facing
  // instance/step lines + Ask/Evidence + the continuation block for the resuming seat.
  const gatePacket = [
    "### Workflow gate: tianqi-mission@1 step plan_signoff",
    "",
    "Workflow instance: 01M4EXAMPLEINSTANCE",
    "Prior step: plan (orchestrator) closed by orch@kernel",
    "This step: plan_signoff (orchestrator)",
    "Gate: human sign-off — the workflow is PARKED (waiting) until this item is resolved/closed; the flow then continues from this step.",
    "Ask: Approve the plan at https://example.invalid/plan.md",
    "Evidence: https://example.invalid/plan.md",
    "Objective: reach plan sign-off",
    "",
    "Continuation: rig workflow project --instance 01M4EXAMPLEINSTANCE",
    "Context: this workflow packet is a shortcut, not the whole story; open the instance for the full plan.",
  ].join("\n");
  const gateRow = {
    qitemId: "q-gate",
    summary: "Approve the plan at https://example.invalid/plan.md",
    body: gatePacket,
    state: "blocked",
    tags: ["workflow", "gate", "workflow:tianqi-mission", "instance:01M4EXAMPLEINSTANCE"],
    destinationSession: "orch@kernel",
  };
  const opts = { sourceLabel: "vm-openrig-build", evidenceLink: "https://example.invalid/plan.md" };

  it("posts the headline (gate.summary) and evidence link, never the agent packet lines", () => {
    const m = buildOutboundMessage(gateRow, opts);
    expect(m.text).toContain("*Approve the plan at https://example.invalid/plan.md*");
    expect(m.text).toContain("Evidence: https://example.invalid/plan.md");
    for (const agentLine of ["### Workflow gate", "Workflow instance:", "Prior step:", "This step:", "Objective:", "Continuation:"]) {
      expect(m.text).not.toContain(agentLine);
      expect(JSON.stringify(m.blocks)).not.toContain(agentLine);
    }
  });

  it("keeps the packet body for a gate row NOT parked on a human (state or gate tag absent)", () => {
    expect(buildOutboundMessage({ ...gateRow, state: "pending" }, opts).text).toContain("Workflow instance:");
    expect(buildOutboundMessage({ ...gateRow, tags: ["workflow", "handoff"] }, opts).text).toContain("Workflow instance:");
  });

  it("falls back to the packet body when the parked gate row carries no plain-language summary", () => {
    expect(buildOutboundMessage({ ...gateRow, summary: null }, opts).text).toContain("Workflow instance:");
  });

  it("keeps the packet body for a hand-tagged [\"gate\"] row that carries no workflow tag", () => {
    expect(buildOutboundMessage({ ...gateRow, tags: ["gate"] }, opts).text).toContain("Workflow instance:");
  });

  it("renders a single Evidence: line when the gate's evidence is a local path (the common case)", () => {
    const m = buildOutboundMessage({ ...gateRow, evidenceRef: "/srv/rig/retained/plan.md" }, { sourceLabel: opts.sourceLabel });
    expect(m.text).toContain("*Approve the plan at https://example.invalid/plan.md*");
    expect((m.text.match(/Evidence:/g) ?? []).length).toBe(1);
    expect(m.text).toContain("Evidence: /srv/rig/retained/plan.md");
    expect(m.text).not.toContain("Workflow instance:");
  });

  it("keeps the Evidence line when the attached media is a different artifact than the evidence", () => {
    const m = buildOutboundMessage(
      { ...gateRow, evidenceRef: "/srv/rig/retained/plan.md" },
      { sourceLabel: opts.sourceLabel, mediaRefs: [{ imageUrl: "https://example.invalid/screenshot.png", altText: "screenshot" }] },
    );
    expect(m.text).toContain("Evidence: /srv/rig/retained/plan.md");
  });

  it("suppresses the Evidence path only when the rendered media carries that same reference", () => {
    const m = buildOutboundMessage(
      { ...gateRow, evidenceRef: "https://example.invalid/plan.md" },
      { sourceLabel: opts.sourceLabel, mediaRefs: [{ imageUrl: "https://example.invalid/plan.md", altText: "the plan" }] },
    );
    expect(m.text).not.toContain("Evidence:");
  });

  it("names the workflow and instance so two instances parked at the same gate are distinguishable", () => {
    const instanceA = buildOutboundMessage(
      { ...gateRow, tags: [...gateRow.tags, "step:plan_signoff"] },
      opts,
    );
    const instanceB = buildOutboundMessage(
      { ...gateRow, tags: ["workflow", "gate", "workflow:tianqi-mission", "instance:01M4OTHERINSTANCE", "step:plan_signoff"] },
      opts,
    );
    expect(instanceA.text).toContain("Workflow tianqi-mission · instance 01M4EXAMPLEINSTANCE · step plan_signoff");
    expect(instanceB.text).toContain("Workflow tianqi-mission · instance 01M4OTHERINSTANCE · step plan_signoff");
    expect(instanceA.text).not.toBe(instanceB.text);
    // The context line rides in a block too, not only the fallback text.
    expect(JSON.stringify(instanceA.blocks)).toContain("instance 01M4EXAMPLEINSTANCE");
    // Still no agent packet — the context line only, not the instance/step packet lines.
    expect(instanceA.text).not.toContain("Workflow instance:");
    expect(instanceA.text).not.toContain("Continuation:");
  });

  it("shortens very long workflow, instance and step tags so the gate still posts", () => {
    const m = buildOutboundMessage({
      ...gateRow,
      tags: ["workflow", "gate", `workflow:${"w".repeat(5000)}`, `instance:${"<".repeat(2000)}`, `step:${"\u{1F600}".repeat(200)}`],
    }, opts);
    // Each value keeps 32 characters, an ellipsis, its last 33 and a 12-hex digest, cut before escaping, so no escape or emoji is split.
    expect(m.text).toMatch(new RegExp(`Workflow w{32}…w{33} #[0-9a-f]{12} · instance (&lt;){32}…(&lt;){33} #[0-9a-f]{12} · step (\u{1F600}){32}…(\u{1F600}){33} #[0-9a-f]{12}`, "u"));
    expect(m.text).not.toContain("w".repeat(34));
    const context = m.blocks[2] as { type: string; elements: Array<{ text: string }> }; // after the sender and the ask
    expect(context.type).toBe("context");
    expect(m.text).toContain(context.elements[0]!.text);
    expect(m.text.length).toBeLessThanOrEqual(SLACK_TEXT_CAP);
  });

  it("keeps two long instance labels that differ only at the end distinct", () => {
    const instance = (suffix: string) => buildOutboundMessage(
      { ...gateRow, tags: ["workflow", "gate", "workflow:tianqi-mission", `instance:${"p".repeat(79)}${suffix}`, "step:plan_signoff"] },
      opts,
    );
    const a = instance("-A");
    const b = instance("-B");
    expect(a.text).toContain(`${"p".repeat(31)}-A #`);
    expect(b.text).toContain(`${"p".repeat(31)}-B #`);
    expect(a.text).not.toBe(b.text);
    expect(JSON.stringify(a.blocks)).not.toBe(JSON.stringify(b.blocks));
    // An instance label of ordinary length (a ULID) is shown whole.
    expect(buildOutboundMessage(gateRow, opts).text).toContain("instance 01M4EXAMPLEINSTANCE");
  });

  it("keeps two long instance labels that differ only in the middle distinct", () => {
    // These two labels share their first 6 digest characters (b20078), so a 6-character digest posted them identically.
    const instance = (middle: string) => buildOutboundMessage(
      { ...gateRow, tags: ["workflow", "gate", "workflow:tianqi-mission", `instance:${"p".repeat(35)}${middle}${"z".repeat(36)}`, "step:plan_signoff"] },
      opts,
    );
    const a = instance("label-00000219");
    const b = instance("label-00004669");
    expect(a.text).toContain(`instance ${"p".repeat(32)}…${"z".repeat(33)} #b200786b3a4e`);
    expect(b.text).toContain(`instance ${"p".repeat(32)}…${"z".repeat(33)} #b200784519a9`);
    expect(a.text).not.toBe(b.text);
    expect(JSON.stringify(a.blocks)).not.toBe(JSON.stringify(b.blocks));
  });

  it("never cuts the redaction marker in a shortened tag value", () => {
    // Short leads keep the marker whole in the shortened value; longer ones leave it out. Never a part of it.
    let keptWhole = 0;
    for (let lead = 0; lead <= 40; lead++) {
      const m = buildOutboundMessage({
        ...gateRow,
        tags: ["workflow", "gate", "workflow:tianqi-mission", `instance:${"x".repeat(lead)}xoxb-${"1".repeat(30)} ${"y".repeat(100)}`],
      }, opts);
      expect(m.text).not.toMatch(/\[redacted-se(?!cret\])/);
      expect(m.text).not.toContain("xoxb-");
      if (m.text.includes("[redacted-secret]")) keptWhole++;
    }
    expect(keptWhole).toBeGreaterThan(0);
  });

  it("shows only the instance when the whole context line would push a near-limit gate over budget", () => {
    const tags = ["workflow", "gate", `workflow:${"&".repeat(100)}`, `instance:${"&".repeat(100)}`, `step:${"&".repeat(100)}`];
    const summary = "s".repeat(2990);
    const m = buildOutboundMessage({ ...gateRow, summary, tags }, opts);
    expect(m.text.length).toBeLessThanOrEqual(SLACK_TEXT_CAP);
    expect(m.text).toContain(summary);
    expect(m.text).not.toContain("Workflow ");
    expect(m.text).toMatch(/instance (&amp;){32}…(&amp;){33} #[0-9a-f]{12}/);
    expect(JSON.stringify(m.blocks)).toContain("instance &amp;");
    // The same tags with an ordinary summary keep the whole line.
    expect(buildOutboundMessage({ ...gateRow, tags }, opts).text).toContain("Workflow &amp;");
  });

  it("leaves the context line out when even the instance part would push the gate over budget", () => {
    const tags = ["workflow", "gate", `workflow:${"&".repeat(100)}`, `instance:${"&".repeat(100)}`];
    const m = buildOutboundMessage(
      { ...gateRow, summary: "s".repeat(2990), evidenceRef: `/tmp/${"e".repeat(850)}`, tags },
      { sourceLabel: "vm-openrig-build" },
    );
    expect(m.text.length).toBeLessThanOrEqual(SLACK_TEXT_CAP);
    expect(m.text).toContain(`Evidence: /tmp/${"e".repeat(850)}`);
    expect(m.text).not.toContain("instance ");
    expect(JSON.stringify(m.blocks)).not.toContain("instance ");
  });

  it("omits the step from the context line when the row carries no step tag", () => {
    const m = buildOutboundMessage(gateRow, opts);
    expect(m.text).toContain("Workflow tianqi-mission · instance 01M4EXAMPLEINSTANCE");
    expect(m.text).not.toContain("step ");
  });
});


describe("question and conversation cues", () => {
  it("marks a human-required question as answerable without labelling an ordinary update an answer", () => {
    const question = { qitemId: "q", ownerNotificationKind: "human-required", summary: "Which branch?", body: "Choose a branch." };
    const shown = buildOutboundMessage(question, { sourceLabel: "fixture" });
    expect(shown.text).toContain("Reply in this thread after this question to answer it.");
    expect(JSON.stringify(shown.blocks)).toContain("Earlier and extra messages still reach the agent as conversation.");
    const update = buildOutboundMessage({ ...question, ownerNotificationKind: "human-update" }, { sourceLabel: "fixture" });
    expect(update.text).not.toContain("to answer it");
    expect(JSON.stringify(update.blocks)).not.toContain("to answer it");
  });
});
