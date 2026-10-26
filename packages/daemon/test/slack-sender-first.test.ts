// In a channel where many agents post, the person sees who is asking before the ask: every gateway post starts with
// "From <seat> on <host>", in the blocks and in the fallback text a notification shows. A wake-rung escalation also
// names the seat the work is waiting on, while its sender and reply routing stay those of the row.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildOutboundMessage, attributionFromSession } from "../src/domain/gateway/slack/message.js";
import { makeOperatorDeliveryEngine } from "../src/domain/gateway/operator-delivery-engine.js";
import type { QueueItem } from "../src/domain/queue-repository.js";

const q = { qitemId: "q1", summary: "Decide X", body: "The details.", destinationSession: "person@external" };
const contextText = (block: unknown) => (block as { type: string; elements?: Array<{ text: string }> }).type === "context"
  ? (block as { elements: Array<{ text: string }> }).elements[0]!.text : null;

describe("a gateway post names its sender first", () => {
  it.each([
    ["a full session", { attribution: attributionFromSession("lead@team@vps04") }, "From lead@team@vps04"],
    ["a session and the machine it runs on", { attribution: attributionFromSession("lead@team"), machine: "vps04" }, "From lead@team on vps04"],
    ["no seat, only the queue's place", {}, "From vm"],
  ] as const)("%s: the first block and the first fallback line", (_name, opts, sender) => {
    const m = buildOutboundMessage(q, { sourceLabel: "vm", ...opts });
    expect(contextText(m.blocks[0])).toBe(sender);
    expect((m.blocks[1] as { type: string; text: { text: string } }).text.text).toBe("*Decide X*");
    expect(m.text.split("\n")[0]).toBe(sender);
    expect(m.text.split("\n")[1]).toBe("*Decide X*");
    // Named once: no second sender line at the end.
    expect(m.blocks.filter((b) => contextText(b)?.startsWith("From "))).toHaveLength(1);
  });

  it("at Slack's 50-block limit the repeat note is still the block left out, never the sender or the ask", () => {
    const mediaRefs = Array.from({ length: 47 }, (_, i) => ({ imageUrl: `https://example.com/i${i}.png`, altText: `image ${i}` }));
    const m = buildOutboundMessage(q, { sourceLabel: "vm", attribution: attributionFromSession("lead@team"), mediaRefs, possibleRepeat: true });
    expect(m.blocks).toHaveLength(50);
    expect(contextText(m.blocks[0])).toBe("From lead@team");
    expect((m.blocks[1] as { text: { text: string } }).text.text).toBe("*Decide X*");
    expect(m.blocks.some((b) => contextText(b)?.startsWith("Delivery may repeat"))).toBe(false);
  });
});

describe("a wake-rung escalation names the seat the work is waiting on", () => {
  const registry = { loadHumanRegistry: () => ({ ok: true as const, entities: [{
    entityId: "person", class: "human" as const, displayName: "Person", address: "person@external",
    connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UPERSON" }],
    prefs: { deliveryClass: "C", availability: "available" },
  }] }) };
  const escalate = async (row: Partial<QueueItem>) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sender-first-"));
    try {
      const sent: Array<Record<string, unknown>> = [];
      const engine = makeOperatorDeliveryEngine({ home, registry,
        queueRepo: { transitionLog: { latestOwnerNotificationForQitem: () => null }, db: undefined } as never,
        dispatch: (_op, _ref, payload) => { sent.push(payload as Record<string, unknown>); return { ok: true, decisionId: "d" } as never; } });
      await engine.dispatchEscalation({ qitemId: "q-stuck", body: "Please review.", tags: [], ...row } as QueueItem, "unclaimed");
      return sent[0]!;
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  };

  it("the headline says whom the row is waiting on; the sender stays the row's own, so a reply still reaches it", async () => {
    const payload = await escalate({ sourceSession: "lead@team", destinationSession: "dev-impl@team", summary: "Review the parser" });
    expect(payload.sourceSession).toBe("lead@team");
    expect(payload.summary).toBe("Waiting on dev-impl@team: Review the parser");
    const m = buildOutboundMessage(payload as never, { sourceLabel: "vm", attribution: attributionFromSession(payload.sourceSession as string), machine: "vps04" });
    expect(m.text.split("\n")[0]).toBe("From lead@team on vps04");
    expect(m.text.split("\n")[1]).toContain("Waiting on dev-impl@team: Review the parser");
  });

  it("a row with no sender still names the stuck seat, and the post says it comes from the queue's place", async () => {
    const payload = await escalate({ sourceSession: null as never, destinationSession: "dev-impl@team", summary: null as never });
    expect(payload.summary).toBe("Waiting on dev-impl@team: wake-ladder escalation: q-stuck");
    const m = buildOutboundMessage(payload as never, { sourceLabel: "vm", attribution: attributionFromSession(payload.sourceSession as null) });
    expect(m.text.split("\n")[0]).toBe("From vm");
    expect(m.text).toContain("Waiting on dev-impl@team");
  });
});
